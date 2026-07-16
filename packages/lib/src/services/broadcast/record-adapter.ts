/**
 * The durable ledger: `broadcast_recipients` in place of a JSONL file on someone's laptop.
 *
 * This is the module that decides whether a person can be emailed twice, so its rules are
 * narrow on purpose:
 *
 *  - `UNIQUE(broadcastId, userId)` is the idempotency backbone. Every write is an upsert
 *    against that constraint, so two workers racing the same recipient produce one row,
 *    not two sends.
 *  - `recordSent` still throws `LedgerWriteFailed` on failure, exactly as the file ledger
 *    did. The email is already gone; if we cannot remember that, the send loop must stop
 *    rather than march on and re-mail everyone after the next retry.
 *  - `email_notification_log` gets a SECONDARY row for analytics only. It has no
 *    uniqueness and is a shared append sink, so it can never be the answer to "did we
 *    already send this?" — a failure to write it is swallowed, because losing an
 *    analytics row must not fail a send that succeeded.
 */

import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNull, lt, ne, or, sql } from '@pagespace/db/operators';
import { broadcastRecipients } from '@pagespace/db/schema/email-broadcasts';
import { emailNotificationLog } from '@pagespace/db/schema/email-notifications';
import { LedgerWriteFailed, type SentLedgerEntry, type SkipReason } from './core';
import type { NotificationTypeValue } from '@pagespace/db/schema/notifications';

/**
 * The resume set: userIds already mailed for this broadcast.
 *
 * Keyed on `status = 'sent'` in `broadcast_recipients` and NEVER on
 * `email_notification_log` — the log records attempts from every subsystem with no
 * uniqueness, so reading it would both miss and invent already-sent recipients.
 */
export async function loadAlreadySentUserIds(broadcastId: string): Promise<Set<string>> {
  const rows = await db
    .select({ userId: broadcastRecipients.userId })
    .from(broadcastRecipients)
    .where(
      and(eq(broadcastRecipients.broadcastId, broadcastId), eq(broadcastRecipients.status, 'sent')),
    );
  return new Set(rows.map((r) => r.userId));
}

/**
 * The same resume set, but keyed by normalized ADDRESS — which is what `decideRecipient`
 * and `runBroadcast` compare against.
 *
 * Scope, precisely: this covers a RESUMED run (the addresses a previous run already
 * mailed) and, together with the in-memory set, two accounts sharing one address within
 * ONE process. It is not a cross-worker guard for that case — `claimRecipient` conflicts
 * on `(broadcastId, userId)`, so two workers each claiming a different account that
 * happens to share an address would both win. What actually prevents that upstream is
 * `users.emailBidx`, the deterministic-HMAC unique index: two accounts cannot hold the
 * same address in the first place. (That index is nullable, so it only binds rows the PII
 * encryption backfill has covered — which is all of them today.)
 */
export async function loadAlreadySentEmails(broadcastId: string): Promise<Set<string>> {
  const rows = await db
    .select({ recipientEmail: broadcastRecipients.recipientEmail })
    .from(broadcastRecipients)
    .where(
      and(eq(broadcastRecipients.broadcastId, broadcastId), eq(broadcastRecipients.status, 'sent')),
    );
  return new Set(rows.map((r) => r.recipientEmail.trim().toLowerCase()));
}

/**
 * How long a claim holds a recipient before another worker may take it.
 *
 * Long enough that a healthy worker's send (a provider round-trip plus the inter-send
 * delay) never expires mid-flight; short enough that a crashed worker's recipients are
 * reachable again in minutes rather than never.
 */
export const CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Proof that a particular worker holds a particular claim.
 *
 * Ownership has to be provable, not assumed. A write keyed only on `(broadcastId, userId)`
 * cannot distinguish the worker currently holding a recipient from one whose lease expired
 * ten minutes ago and is only now getting around to reporting — and letting the latter
 * write would revoke the former's claim mid-send. Carrying this back and requiring it to
 * still match turns "I once had this" into "I still have this".
 *
 * An opaque id rather than the `claimed_at` stamp, because that comparison cannot be made
 * to work: Postgres keeps microseconds, a JS Date holds milliseconds, so a stamp read back
 * through the driver never equals the stored value. The fence would match nothing and
 * quietly stop releasing anything — failing OPEN in the one place that must fail closed.
 */
export interface ClaimLease {
  readonly token: string;
}

/**
 * The lease's clock is POSTGRES'S, never a worker's.
 *
 * A lease stamped by one process and judged by another is only as good as the agreement
 * between their clocks, and this is the one mechanism preventing a double-send. Six
 * minutes of skew on a single host is enough to break it: worker A claims a recipient and
 * stamps its own slow clock, worker B computes a lease floor from its own correct clock,
 * decides A's fresh lease already expired, steals it, and both mail the same person.
 * (Skew the other way fails safe — a lease merely becomes unstealable for a while.)
 *
 * Reading and writing the instant in the database removes the disagreement rather than
 * bounding it: there is only ever one clock.
 *
 * `at time zone 'utc'` because the column is `timestamp without time zone` while `now()`
 * is `timestamptz` — the cast would otherwise resolve through the session's TimeZone,
 * whereas Drizzle writes its own Dates as UTC (`toISOString()`) and reads them back as
 * UTC. Pinning to UTC here keeps every writer on the one convention.
 */
function dbNow() {
  return sql`(now() at time zone 'utc')`;
}

/** The instant a lease older than this has expired, on the database's clock. */
function leaseFloorSql(leaseMs: number) {
  return sql`${dbNow()} - make_interval(secs => ${leaseMs / 1000})`;
}

/** A lease so far out that no retry will outlive it — see parkClaimAgainstRetry. */
function foreverFromNowSql() {
  return sql`${dbNow()} + interval '100 years'`;
}

/**
 * Take ownership of a recipient before mailing them. Returns false when someone else has
 * them — the caller must NOT send.
 *
 * This exists because the unique constraint cannot prevent a double-send on its own: it
 * coalesces the LEDGER, and it only does so after both workers have already handed mail
 * to the provider. The in-memory `alreadySent` set is per-process and cannot help across
 * instances or overlapping retries. So ownership has to be decided in the database, in
 * one atomic statement, BEFORE the provider call.
 *
 * The single upsert below is that statement. It succeeds only when the row is not already
 * `sent` AND nobody holds an unexpired lease, so exactly one of two racing workers gets a
 * row back:
 *
 *  - fresh recipient  → the INSERT wins → claimed.
 *  - a rival holds it → the conflict path's WHERE fails on the fresh `claimedAt` → false.
 *  - already sent     → the WHERE fails on the status → false (the backstop for when the
 *                       resume set was read before the rival's send landed).
 *  - crashed worker   → its lease has expired → the WHERE passes → reclaimed, so a
 *                       mid-send crash costs a lease interval rather than stranding the
 *                       recipient as `pending` forever.
 *
 * A claim is not a promise to send: a claimed recipient whose send then fails is recorded
 * `failed` and retried later (its lease expires like any other).
 *
 * This also owns the `attempts` counter — one increment per worker that takes the
 * recipient — so the number reads as "times we tried to mail this person". The record
 * writes below deliberately leave it alone rather than counting the same try twice.
 * That holds because claiming is this module's contract: every durable send is
 * claim -> send -> record, and a caller that records without claiming has already given
 * up its protection against double-sending, which is a bigger problem than a stale count.
 *
 * @returns the lease on success — proof, for the later write, that this worker is the one
 *   holding the recipient. Without it a write cannot tell "release MY lease" from "revoke
 *   a stranger's", and a worker whose send hung past its lease would clobber the rival
 *   that legitimately took over. `null` means someone else owns them: do not send.
 */
export async function claimRecipient(
  broadcastId: string,
  input: { userId: string; email: string },
  opts: { leaseMs?: number } = {},
): Promise<ClaimLease | null> {
  const leaseMs = opts.leaseMs ?? CLAIM_LEASE_MS;
  // Minted here, not read back, so the token this worker believes it holds is by
  // construction the one the row carries — no round-trip, nothing to lose in conversion.
  const token = createId();

  const rows = await db
    .insert(broadcastRecipients)
    .values({
      broadcastId,
      userId: input.userId,
      recipientEmail: input.email,
      status: 'pending',
      claimedAt: dbNow(),
      claimedBy: token,
      attempts: 1,
    })
    .onConflictDoUpdate({
      target: [broadcastRecipients.broadcastId, broadcastRecipients.userId],
      set: {
        claimedAt: dbNow(),
        claimedBy: token,
        recipientEmail: input.email,
        attempts: sql`${broadcastRecipients.attempts} + 1`,
        updatedAt: dbNow(),
      },
      setWhere: and(
        ne(broadcastRecipients.status, 'sent'),
        or(
          isNull(broadcastRecipients.claimedAt),
          lt(broadcastRecipients.claimedAt, leaseFloorSql(leaseMs)),
        ),
      ),
    })
    .returning({ id: broadcastRecipients.id });

  // No row back means the conflict path's WHERE rejected the update: someone else owns
  // this recipient, or already mailed them.
  return rows.length > 0 ? { token } : null;
}

/**
 * Hold a claim open indefinitely so no retry can reclaim the recipient.
 *
 * Used only when a send succeeded but could not be recorded: the person HAS the email, so
 * the safe reading of that row is "nobody touch this", and a lease nobody can steal says
 * exactly that in the vocabulary the claim already speaks. Deliberately not a status
 * change — `sent` is the write that just failed, and inventing a different status to mean
 * "probably sent" would put a lie in the ledger the admin UI reads.
 *
 * Swallows its own failure: this runs on a path that is already fatal, and the caller's
 * error is the thing the operator needs to see.
 */
async function parkClaimAgainstRetry(broadcastId: string, userId: string): Promise<void> {
  try {
    await db
      .update(broadcastRecipients)
      .set({
        claimedAt: foreverFromNowSql(),
        // Drop the token too: a park must be unreleasable, and a lease that matches
        // nothing is a lease nobody can use to undo this.
        claimedBy: null,
        errorMessage: 'sent but not recorded — parked so no retry re-sends; see LedgerWriteFailed',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(broadcastRecipients.broadcastId, broadcastId),
          eq(broadcastRecipients.userId, userId),
          // Never touch a row that did record a send.
          ne(broadcastRecipients.status, 'sent'),
        ),
      );
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.error(
      `[broadcast] could not park ${userId} after an unrecorded send: ${why}. ` +
        'A retry may re-send to them once the claim lease expires.',
    );
  }
}

/**
 * Record one successful send, durably, before the loop moves on.
 *
 * The upsert promotes whatever was there (a `pending` placeholder, a prior `failed`
 * attempt) to `sent`. It never demotes: see `recordFailure`/`recordSkip`, which refuse to
 * overwrite a `sent` row.
 *
 * @throws LedgerWriteFailed - the send happened but was not recorded. Fatal by design.
 */
export async function recordSent(
  broadcastId: string,
  entry: SentLedgerEntry,
  notificationType: NotificationTypeValue,
): Promise<void> {
  const sentAt = new Date(entry.sentAt);

  try {
    await db
      .insert(broadcastRecipients)
      .values({
        broadcastId,
        userId: entry.userId,
        recipientEmail: entry.email,
        status: 'sent',
        sentAt,
        attempts: 1,
      })
      .onConflictDoUpdate({
        target: [broadcastRecipients.broadcastId, broadcastRecipients.userId],
        set: {
          status: 'sent',
          recipientEmail: entry.email,
          sentAt,
          errorMessage: null,
          skipReason: null,
          // `attempts` is deliberately untouched: claimRecipient owns that counter, and a
          // durable send is always claim -> send -> record. Incrementing here too would
          // report 2 attempts for a clean first-try send.
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    // The recipient has the email and nothing remembers it. Stop the run — but first, try
    // to make sure the clock cannot finish the job for us.
    //
    // The file ledger was safe by default here: nothing re-sends until a human re-runs.
    // A lease is not. Left alone, this row stays `pending` with a claim that expires in
    // ~5 minutes, after which ANY retry — a queue with backoff, no human involved — sees
    // a reclaimable row and mails them a second time. The Resend idempotency key
    // (`broadcast:<id>:<userId>`) collapses that within ~24h, but that is a backstop, not
    // a fix: after the window, the second copy is real. Documenting that hazard is not
    // the same as defending against it.
    //
    // So park the row: a lease far in the future is one nobody can steal, which restores
    // "nothing re-sends until someone looks at it". Best-effort by construction — the
    // write that just failed may be the same write failing again — but when the failure
    // was transient (a serialization error, a dropped connection) rather than a full
    // outage, this is the difference between a duplicate and none. If it fails too, we
    // are no worse off than before, and the operator still has the remediation below.
    await parkClaimAgainstRetry(broadcastId, entry.userId);

    // The remediation carries PLACEHOLDERS, never the recipient's data. Pasting an address
    // into a quoted SQL literal breaks on the first apostrophe (O'Brien) and turns a
    // hostile value into injection the operator runs by hand — and the message itself is
    // logged, which is not somewhere an address belongs. The values live on `error.entry`,
    // where a caller can render them deliberately.
    throw new LedgerWriteFailed(
      entry,
      error,
      `   The send is NOT recorded. A best-effort attempt was made to park this recipient so\n` +
        `   an automatic retry cannot re-send to them; if that also failed, the claim is a lease\n` +
        `   expiring in ~${Math.round(CLAIM_LEASE_MS / 60_000)}m and a retry WILL mail them again.\n` +
        `   Record it yourself to be certain (bind the values from this error's \`entry\`), then re-run:\n` +
        `     insert into broadcast_recipients (id, broadcast_id, user_id, recipient_email, status, sent_at)\n` +
        `     values ($1, $2, $3, $4, 'sent', $5)\n` +
        `     on conflict (broadcast_id, user_id) do update set status = 'sent', sent_at = excluded.sent_at;\n` +
        `     -- $2 = broadcast ${broadcastId}; $1 = a fresh cuid; $3/$4/$5 = entry.userId / .email / .sentAt`,
    );
  }

  // Secondary analytics record. Best-effort: the send succeeded and IS recorded above, so
  // failing the broadcast over an analytics insert would be a strictly worse outcome.
  try {
    await db.insert(emailNotificationLog).values({
      userId: entry.userId,
      notificationType,
      recipientEmail: entry.email,
      success: true,
      sentAt,
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.warn(`[broadcast] analytics log write failed for ${entry.userId}: ${why}`);
  }
}

/**
 * Note that a recipient was deliberately not mailed, and why.
 *
 * Unlike `recordSent` this does not throw: a lost skip note cannot cause a double-send,
 * and aborting a broadcast because we failed to write "we correctly declined to email
 * this person" would trade a real send for a bookkeeping detail.
 */
export async function recordSkip(
  broadcastId: string,
  input: { userId: string; email: string | null; reason: SkipReason },
): Promise<void> {
  try {
    await db
      .insert(broadcastRecipients)
      .values({
        broadcastId,
        userId: input.userId,
        recipientEmail: input.email ?? '',
        status: 'skipped',
        skipReason: input.reason,
      })
      .onConflictDoUpdate({
        target: [broadcastRecipients.broadcastId, broadcastRecipients.userId],
        set: {
          status: 'skipped',
          skipReason: input.reason,
          updatedAt: new Date(),
        },
        // Never demote a completed send to 'skipped'. On a resumed run every
        // already-mailed recipient decides as `already-sent`, and without this guard the
        // resume would erase the very rows that make it a resume.
        setWhere: sql`${broadcastRecipients.status} <> 'sent'`,
      });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.warn(`[broadcast] skip write failed for ${input.userId}: ${why}`);
  }
}

/**
 * Note that a send failed, so the admin can see why and a retry can pick it up.
 *
 * The row is written as `failed`, never `sent` — including for `sendEmail`'s 3-per-hour
 * rate-limit throw, which is a per-recipient, retryable condition rather than a delivery.
 * Like `recordSkip`, a write failure here is swallowed: the email did NOT go out, so the
 * worst case is that a retry mails someone we already know we owe an email.
 */
export async function recordFailure(
  broadcastId: string,
  input: { userId: string; email: string; error: string },
  lease: ClaimLease | null = null,
): Promise<void> {
  try {
    await db
      .insert(broadcastRecipients)
      .values({
        broadcastId,
        userId: input.userId,
        recipientEmail: input.email,
        status: 'failed',
        errorMessage: input.error,
        attempts: 1,
      })
      .onConflictDoUpdate({
        target: [broadcastRecipients.broadcastId, broadcastRecipients.userId],
        set: {
          status: 'failed',
          errorMessage: input.error,
          // Not incremented here either — see recordSent. The claim counted this try.
          //
          // RELEASE the lease, but only when we can prove it is OURS (see setWhere). This
          // send is over, so continuing to hold the recipient would make a prompt retry a
          // no-op: after a provider blip every failed row would refuse to be reclaimed for
          // ~5 minutes while the run logged "claimed by another worker" about a worker
          // that does not exist. Releasing without the proof is worse than not releasing —
          // it hands the recipient to a third worker while the second is mid-send.
          ...(lease ? { claimedAt: null, claimedBy: null } : {}),
          updatedAt: new Date(),
        },
        setWhere: lease
          ? and(
              // A late failure must never unmark a real send...
              ne(broadcastRecipients.status, 'sent'),
              // ...nor speak for a claim we no longer hold. `sendOne` has no timeout, so a
              // send CAN outlive its lease (the codebase anticipates exactly this: a send
              // Resend accepts whose response never arrives). By then another worker may
              // have legitimately reclaimed the recipient — or an unrecorded send may have
              // parked the row. Matching on the exact stamp means a stale worker updates
              // nothing rather than clobbering either.
              eq(broadcastRecipients.claimedBy, lease.token),
            )
          : // No lease to prove ownership with: record the failure, but leave the claim
            // alone. A stale status is recoverable; a revoked lease is a double-send.
            ne(broadcastRecipients.status, 'sent'),
      });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.warn(`[broadcast] failure write failed for ${input.userId}: ${why}`);
  }
}

/**
 * The durable ledger for ONE broadcast run, wired for `runBroadcast`.
 *
 * Exists to keep the lease honest. `claimRecipient` hands back proof of ownership, and
 * `recordFailure` needs that proof — but `runBroadcast` is storage-agnostic and has no
 * business carrying a database token between its hooks. So the proof is remembered here,
 * by the worker that earned it: this object IS one worker's knowledge of what it holds.
 *
 * Per-run and per-process on purpose. The map is not a cache to be shared or persisted —
 * a lease another process stamped is precisely the thing this worker must NOT claim to
 * own. Losing the map (a crash) loses nothing that matters: the leases expire.
 *
 *   const ledger = createBroadcastLedger(broadcastId, 'PRODUCT_UPDATE');
 *   await runBroadcast({ ...rest, claim: ledger.claim, record: ledger.record,
 *                        onSkip: ledger.onSkip, onFailure: ledger.onFailure });
 */
export function createBroadcastLedger(
  broadcastId: string,
  notificationType: NotificationTypeValue,
  opts: { leaseMs?: number } = {},
) {
  /** userId -> the lease THIS run holds. Absent means we hold nothing for them. */
  const held = new Map<string, ClaimLease>();

  return {
    claim: async (r: { userId: string; email: string }): Promise<boolean> => {
      const lease = await claimRecipient(broadcastId, r, opts);
      if (!lease) {
        // Someone else owns them. Drop any lease we thought we had: it is stale by
        // definition, and acting on it later is the bug this whole seam prevents.
        held.delete(r.userId);
        return false;
      }
      held.set(r.userId, lease);
      return true;
    },

    record: (entry: SentLedgerEntry): Promise<void> =>
      recordSent(broadcastId, entry, notificationType),

    onSkip: (skip: { userId: string; email: string | null; reason: SkipReason }): Promise<void> =>
      recordSkip(broadcastId, skip),

    onFailure: (failure: { userId: string; email: string; error: string }): Promise<void> =>
      recordFailure(broadcastId, failure, held.get(failure.userId) ?? null),
  };
}

/** Per-status counts for the admin progress view, straight from the ledger. */
export async function countRecipientsByStatus(
  broadcastId: string,
): Promise<Record<'pending' | 'sent' | 'skipped' | 'failed', number>> {
  const rows = await db
    .select({ status: broadcastRecipients.status, value: sql<number>`count(*)::int` })
    .from(broadcastRecipients)
    .where(eq(broadcastRecipients.broadcastId, broadcastId))
    .groupBy(broadcastRecipients.status);

  const counts = { pending: 0, sent: 0, skipped: 0, failed: 0 };
  for (const row of rows) counts[row.status] = row.value;
  return counts;
}

/** The recipients a retry should attempt: everything not already sent or skipped. */
export async function listRetryableRecipients(broadcastId: string) {
  return db
    .select()
    .from(broadcastRecipients)
    .where(
      and(
        eq(broadcastRecipients.broadcastId, broadcastId),
        inArray(broadcastRecipients.status, ['pending', 'failed']),
      ),
    );
}