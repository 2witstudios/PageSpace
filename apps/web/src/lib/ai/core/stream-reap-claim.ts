import { db } from '@pagespace/db/db';
import { and, eq, isNull, lte, or, sql, type SQL } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { STREAM_HEARTBEAT_STALE_MS } from '@/lib/ai/core/stream-liveness';

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE CLAIM IS A FENCE, NOT THE ELIGIBILITY DECISION. Read this before changing anything here.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The SQL predicate below is deliberately a STRICT SUBSET of `isProvablyDead`
 * (stream-liveness.ts). It expresses only "still streaming, and the heartbeat is stale" — it
 * does NOT express `heartbeatStoppedAtCap` or `isBeyondReconcileBackstop`, which is where the
 * genuinely hard part of that judgement lives: a generation still alive at the heartbeat cap
 * stops beating BY DESIGN, so a stale beat is not, on its own, proof of death.
 *
 * So callers must still gate on `isProvablyDead` FIRST, and this must never be widened past it.
 * Getting that backwards does not produce a subtly wrong log line — it deletes live streams. A
 * long deep-research run past the one-hour cap looks exactly like a stale row to the predicate
 * here, and nothing else would stop the reap.
 *
 * WHAT THE CLAIM IS FOR, then, is the OTHER half — the half a JS predicate cannot do at all:
 *
 *   1. TOCTOU. `isProvablyDead` runs against a row read seconds earlier. Between that read and
 *      the destructive write, the "dead" owner can beat again (a Postgres stall that cleared,
 *      a paused machine that resumed). The claim's WHERE clause re-evaluates staleness at
 *      WRITE time, in the same statement that takes the claim.
 *   2. CLOCK SKEW. `isProvablyDead(row, Date.now())` compares a Postgres timestamp against the
 *      READING instance's clock. At N=1 there is one clock and it cancels out. At N>1 two
 *      machines drift, and the reaper is the one path where drift becomes deletion. Every
 *      comparison here is the database's own clock against a column — Postgres on both sides,
 *      and read as UTC so the session's TimeZone cannot redefine it. See `dbNow` below.
 *   3. MUTUAL EXCLUSION. At N>1 several instances sweep the same rows concurrently. Exactly
 *      one UPDATE can set `reap_claimed_at`; the losers match zero rows and stand down.
 *
 *      This rests on READ COMMITTED's re-check, not on luck: the second UPDATE blocks on the
 *      row lock the first took, and when it unblocks Postgres re-evaluates its WHERE clause
 *      against the UPDATED tuple. `reap_claimed_at` is fresh by then, so the TTL branch is
 *      false and the statement matches nothing. Two claims cannot both win. (Their tokens
 *      would also differ — each statement is its own transaction, so each gets its own `now()`
 *      — but the re-check is what makes it safe, and the distinct tokens are only what makes
 *      the FENCE able to tell them apart afterwards.)
 *
 * WHY NOT AN OWNER TOKEN, and why not a CAS on `status` alone — both were considered and both
 * are non-answers, so they are recorded here rather than rediscovered:
 *
 *   - An owner-instance column does not help. The reap only fires once the claimant has
 *     already concluded the owner is dead; being told "instance A owns it" restates the belief
 *     the claimant is acting on, and adds no new information.
 *   - A CAS on `status = 'streaming'` alone does not help either. A LIVE owner has not changed
 *     its status — that is the entire problem — so the reaper wins that CAS every single time.
 *
 * The row STAYS `'streaming'` for the whole reap. That is what makes a crashed reaper
 * recoverable: its claim expires after REAP_CLAIM_TTL_MS and the next sweep retries. Do not
 * "tidy" this by settling the row early.
 */

/**
 * How long a claim holds before another sweep may take it.
 *
 * Bounds the damage of a reaper that dies mid-reap (between taking the claim and finishing the
 * message write). Comfortably longer than a whole materialization — a frame-log read, a fold,
 * an upsert and a settle, all against one row — so a slow-but-alive reaper is never overtaken
 * by a second one duplicating its work. Comfortably shorter than the heartbeat stale window, so
 * a genuinely abandoned claim does not measurably delay recovery.
 */
export const REAP_CLAIM_TTL_MS = 60 * 1000;

/**
 * A won claim: the token, plus everything the materializer needs to act.
 *
 * The wide projection is the point. Every caller used to run its own SELECT of these columns
 * and then hand the result to the materializer — three copies of one query, each acting on data
 * that was already seconds old by the time the write ran. `RETURNING` makes the claim and the
 * read the SAME statement, so what the materializer acts on is what the row held at the instant
 * the claim was won.
 */
export interface ReapClaim {
  messageId: string;
  /**
   * The claim token: the exact `reap_claimed_at` Postgres wrote. Every destructive write this
   * reap then issues carries it as an equality predicate.
   */
  claimedAt: Date;
  /**
   * The heartbeat as it stood when the claim was won. Fenced writes require the column to be
   * `<=` this, so a beat landing after the claim (the owner was never dead, or came back)
   * makes them match zero rows.
   */
  heartbeatAtClaim: Date;
  /** The stream's channel — a real pageId, or a synthetic `user:<id>:global` id. Decides which
   *  message the materializer writes. */
  channelId: string;
  conversationId: string;
  /** The stream's owner. For a global-assistant row this doubles as `messages.userId`. */
  userId: string;
  /** The last debounced parts snapshot. The fallback when the durable frame log cannot serve
   *  this message — and sometimes the RICHER of the two, see `recoverParts`. */
  parts: unknown[];
  /** How many frames that snapshot reflects — the comparable measure to the frame log's own
   *  length, and the only thing that can decide which of the two records reaches further. */
  rawPartsCount: number;
  /** The stream's actual start time. The materialized message's `createdAt` on the
   *  insert-if-missing branch — never reap time, or a recovered reply sorts after a follow-up
   *  the user sent in the interim. */
  startedAt: Date;
}

/**
 * `interval` built from a millisecond budget, as a parameter rather than as interpolated SQL.
 *
 * `make_interval(secs => $n)` takes a bind parameter; `interval '$n seconds'` would not, and
 * building it by string concatenation would put a JS number into the statement text.
 */
const staleInterval = (ms: number): SQL => sql`make_interval(secs => ${ms / 1000})`;

/**
 * `now()`, in the convention these columns are actually stored in.
 *
 * `last_heartbeat_at`, `reap_claimed_at` and friends are `timestamp WITHOUT time zone`, and
 * Drizzle writes its JavaScript `Date`s into them as UTC wall-clock (`toISOString()`) and reads
 * them back the same way. `now()` is a `timestamptz`, so comparing it against one of those
 * columns resolves it through the SESSION's TimeZone — and every predicate in this module then
 * silently means something different depending on a database setting nothing here controls.
 *
 * The failure is not subtle in either direction, and one of them is the exact catastrophe this
 * module exists to prevent:
 *
 *   - A session BEHIND UTC makes `now()` earlier than every stored heartbeat, so nothing is ever
 *     stale, no row is ever claimable, and the reap silently stops running — dead rows wedge in
 *     `'streaming'` forever.
 *   - A session AHEAD of UTC makes `now()` later, so LIVE rows look stale by hours and the reaper
 *     destroys generating streams — with the fence agreeing, because the fence reads the same
 *     skewed clock.
 *
 * A UTC-configured server hides both, which is precisely why this is pinned rather than assumed:
 * CI and production are UTC, so nothing would catch a deployment that is not.
 *
 * Same convention, same reasoning, and for the same kind of mechanism (a claim whose whole value
 * is that one clock decides it) as `dbNow()` in
 * `packages/lib/src/services/broadcast/record-adapter.ts`.
 */
const dbNow = (): SQL => sql`(now() at time zone 'utc')`;

/**
 * Take exclusive, time-bounded permission to reap this stream — or answer `null`.
 *
 * `null` covers every "not mine to destroy" case and they are deliberately indistinguishable to
 * the caller: the row left `'streaming'` on its own, its heartbeat is fresh after all, another
 * instance holds an unexpired claim, or the row is gone. In all of them the correct action is
 * the same — do nothing — and a caller that branched on which one would be acting on a
 * distinction Postgres has already resolved.
 *
 * NEVER THROWS. A failed claim is a reap that does not happen, which the next sweep retries; a
 * thrown one would take out the batch loop its callers run it in.
 */
export const claimDeadStream = async ({
  messageId,
  staleAfterMs = STREAM_HEARTBEAT_STALE_MS,
}: {
  messageId: string;
  staleAfterMs?: number;
}): Promise<ReapClaim | null> => {
  try {
    const [row] = await db
      .update(aiStreamSessions)
      // `now()`, not `new Date()`. The token has to come from the same clock the predicates
      // below are evaluated against, or a skewed reaper mints a token that its own TTL
      // comparison then misreads.
      //
      // TRUNCATED TO MILLISECONDS, and this is not cosmetic — without it NOTHING here works.
      // `timestamp` keeps PostgreSQL's microsecond precision, and `RETURNING` hands that back
      // through the driver as a JavaScript `Date`, which holds only milliseconds. Binding that
      // truncated value into the fence's equality then compares `…06.556` against the stored
      // `…06.556568` and matches ZERO rows — so every fenced settle and every frame release
      // would be rejected, the row would never leave `'streaming'`, and the reap would retry
      // forever. Truncating at the source makes the value exactly representable on both sides,
      // so the round trip is lossless. Verified against a real Postgres: `now()` matched 0 rows,
      // `date_trunc('milliseconds', now())` matched 1 (review finding — chatgpt-codex-connector,
      // PR #2419).
      //
      // A millisecond-granular token is still a perfectly good one: it is compared only for
      // equality against itself and for age against a 60s TTL.
      //
      // MOCKED TESTS CANNOT SEE THIS. It lives entirely in the driver's type round trip, so the
      // guard against regression is `stream-reap-claim.integration.test.ts`, which runs the real
      // statements against the real database.
      .set({ reapClaimedAt: sql`date_trunc('milliseconds', ${dbNow()})` })
      .where(and(
        eq(aiStreamSessions.messageId, messageId),
        // A row that already left 'streaming' was reaped, or finished normally. Either way its
        // content is settled and there is nothing here to destroy.
        eq(aiStreamSessions.status, 'streaming'),
        // Staleness, re-evaluated HERE rather than trusted from the caller's earlier read. This
        // is the TOCTOU close: a heartbeat that landed in between makes this false.
        sql`${aiStreamSessions.lastHeartbeatAt} < ${dbNow()} - ${staleInterval(staleAfterMs)}`,
        // Unclaimed, or claimed by a reaper that has since gone quiet.
        or(
          isNull(aiStreamSessions.reapClaimedAt),
          sql`${aiStreamSessions.reapClaimedAt} < ${dbNow()} - ${staleInterval(REAP_CLAIM_TTL_MS)}`,
        ),
      ))
      .returning({
        messageId: aiStreamSessions.messageId,
        claimedAt: aiStreamSessions.reapClaimedAt,
        // UNCHANGED by this UPDATE, so `RETURNING` hands back the value as it stood when the
        // claim was won — which is exactly what the fence needs to compare against.
        heartbeatAtClaim: aiStreamSessions.lastHeartbeatAt,
        channelId: aiStreamSessions.channelId,
        conversationId: aiStreamSessions.conversationId,
        userId: aiStreamSessions.userId,
        parts: aiStreamSessions.parts,
        rawPartsCount: aiStreamSessions.rawPartsCount,
        startedAt: aiStreamSessions.startedAt,
      });

    if (!row) return null;
    if (row.claimedAt === null) {
      // Unreachable: the same statement just set the column. Guarded because the alternative is
      // a claim whose token is null, which would make every fence below degrade to "match
      // anything" — the one failure mode this module exists to prevent.
      loggers.ai.warn('stream-reap-claim: claim returned a null token — refusing the reap', {
        messageId,
      });
      return null;
    }

    return { ...row, claimedAt: row.claimedAt };
  } catch (error) {
    loggers.ai.warn('stream-reap-claim: could not claim stream for reaping', {
      messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
};

/**
 * The predicate every destructive write of a reap must carry.
 *
 * Two clauses, and both are load-bearing:
 *
 *   - `reap_claimed_at = claimedAt` — we still hold the claim. A TTL expiry that let another
 *     sweep take it over, or a re-registered generation, both change this value.
 *   - `last_heartbeat_at <= heartbeatAtClaim` — the owner has not spoken since. This is the one
 *     that catches the case the claim itself cannot: a heartbeat landing AFTER the claim
 *     committed, i.e. an owner that was never dead. Without it the claim would be a lock taken
 *     against a live process.
 *
 * `status = 'streaming'` rides along because a row that has left it has already been settled by
 * some other path, and re-settling it would relabel a correct terminal state.
 */
export const reapClaimFence = (claim: ReapClaim): SQL => and(
  eq(aiStreamSessions.messageId, claim.messageId),
  eq(aiStreamSessions.status, 'streaming'),
  eq(aiStreamSessions.reapClaimedAt, claim.claimedAt),
  lte(aiStreamSessions.lastHeartbeatAt, claim.heartbeatAtClaim),
)!;

/**
 * Does this claim still hold?
 *
 * For the one destructive write that CANNOT carry the fence in its own WHERE clause: the frame
 * log's DELETE targets `ai_stream_frames`, a different table with none of these columns. So the
 * fence is evaluated as a read against the session row, immediately before.
 *
 * That is a narrower guarantee than an atomic fenced UPDATE and it is stated rather than
 * glossed: a heartbeat landing between this check and the DELETE is not caught. It is
 * nonetheless the same window every other cross-table cleanup in this system has, it is
 * milliseconds wide against a two-minute staleness horizon, and the content it protects has by
 * then already been written durably to `messages` — the DELETE runs only after that write is
 * confirmed.
 *
 * Fails CLOSED. An unreadable row answers `false`, so a DB blip skips the release rather than
 * performing it blind; the frames then linger until the retention backstop reclaims them, which
 * is the cheap direction to be wrong in.
 */
export const isReapClaimStillHeld = async (claim: ReapClaim): Promise<boolean> => {
  try {
    const [row] = await db
      .select({ messageId: aiStreamSessions.messageId })
      .from(aiStreamSessions)
      .where(reapClaimFence(claim))
      .limit(1);
    return row !== undefined;
  } catch (error) {
    loggers.ai.warn('stream-reap-claim: could not verify claim before releasing frames', {
      messageId: claim.messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
};
