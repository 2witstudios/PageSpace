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
  return new Set(rows.map((r) => r.userId).filter((id): id is string => id !== null));
}

/**
 * The same resume set, but keyed by normalized ADDRESS — which is what `decideRecipient`
 * and `runBroadcast` compare against, so that two accounts sharing one address cannot
 * both be mailed.
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
 */
export async function claimRecipient(
  broadcastId: string,
  input: { userId: string; email: string },
  opts: { leaseMs?: number } = {},
): Promise<boolean> {
  const leaseMs = opts.leaseMs ?? CLAIM_LEASE_MS;
  const now = new Date();
  const leaseFloor = new Date(now.getTime() - leaseMs);

  const rows = await db
    .insert(broadcastRecipients)
    .values({
      broadcastId,
      userId: input.userId,
      recipientEmail: input.email,
      status: 'pending',
      claimedAt: now,
      attempts: 1,
    })
    .onConflictDoUpdate({
      target: [broadcastRecipients.broadcastId, broadcastRecipients.userId],
      set: {
        claimedAt: now,
        recipientEmail: input.email,
        attempts: sql`${broadcastRecipients.attempts} + 1`,
        updatedAt: now,
      },
      setWhere: and(
        ne(broadcastRecipients.status, 'sent'),
        or(
          isNull(broadcastRecipients.claimedAt),
          lt(broadcastRecipients.claimedAt, leaseFloor),
        ),
      ),
    })
    .returning({ id: broadcastRecipients.id });

  // No row back means the conflict path's WHERE rejected the update: someone else owns
  // this recipient, or already mailed them.
  return rows.length > 0;
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
          attempts: sql`${broadcastRecipients.attempts} + 1`,
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    // The recipient has the email and nothing remembers it. Stop the run.
    throw new LedgerWriteFailed(entry, error);
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
          attempts: sql`${broadcastRecipients.attempts} + 1`,
          updatedAt: new Date(),
        },
        // Same guard as recordSkip: a late failure must never unmark a real send.
        setWhere: sql`${broadcastRecipients.status} <> 'sent'`,
      });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.warn(`[broadcast] failure write failed for ${input.userId}: ${why}`);
  }
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