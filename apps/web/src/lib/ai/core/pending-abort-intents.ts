import { db } from '@pagespace/db/db';
import { eq, and, lt } from '@pagespace/db/operators';
import { aiPendingAbortIntents } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Pre-generation abort intents.
 *
 * Closes the pre-INSERT preflight window (#2028 item 1).
 *
 * `createStreamLifecycle` runs at the END of a route's preflight — after auth, permissions,
 * message persistence, and context assembly (0.5-3s of TTFB). During that window:
 *
 *   - `abortConversationStreams` SELECTs `status='streaming'` rows → 0 rows
 *   - `markAbortRequested` UPDATEs by conversation → 0 rows
 *   - The abort returns `not_found`, which the UI stays SILENT about by design
 *
 * The generation then starts a moment later and runs to completion: write tools, billing, the lot.
 *
 * The fix: when Stop finds nothing, it writes a durable intent HERE. When `createStreamLifecycle`
 * runs, it consumes the intent and, if present, aborts the stream immediately.
 *
 * The intent is keyed by (conversation_id, user_id) — the same authorization model as every
 * other abort mechanism. A user can only create an intent for their own conversation, and
 * `createStreamLifecycle` receives `userId` from the authenticated route.
 */

/**
 * A pending-abort intent expires after this long.
 *
 * The preflight it targets is 0.5-3s. If a send takes longer than this (provider down, cold start,
 * pathological context assembly) and no `createStreamLifecycle` ever consumes the intent, it must
 * not sit in the table forever. A cron or the next `consumePendingAbort` for a different
 * generation on this conversation would clean it up, but the expiry makes the guarantee
 * independent of either.
 *
 * 30s is well beyond any realistic preflight while short enough that a stale intent does not
 * block the NEXT legitimate send on this conversation for long.
 */
export const PENDING_ABORT_INTENT_TTL_MS = 30 * 1000;

/**
 * Record a pending-abort intent for a conversation.
 *
 * Called by `abortStreamAnywhere` when it finds no in-flight stream — the Stop was pressed
 * during the preflight window. The intent is consumed by `createStreamLifecycle` at INSERT time.
 *
 * Upsert (not insert): a second Stop pressed during the same preflight refreshes the timestamp
 * rather than failing on the composite PK.
 */
export const recordPendingAbort = async ({
  conversationId,
  userId,
  now = new Date(),
}: {
  conversationId: string;
  userId: string;
  now?: Date;
}): Promise<void> => {
  try {
    await db
      .insert(aiPendingAbortIntents)
      .values({ conversationId, userId, createdAt: now })
      .onConflictDoUpdate({
        target: [aiPendingAbortIntents.conversationId, aiPendingAbortIntents.userId],
        set: { createdAt: now },
      });
  } catch (error) {
    loggers.ai.warn('pending-abort-intents: could not record abort intent', {
      conversationId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
};

/**
 * Atomically consume a pending-abort intent.
 *
 * Called by `createStreamLifecycle` at INSERT time. DELETE ... RETURNING is atomic: if a row
 * existed, it is removed and we return true — the stream should be pre-aborted. If no row
 * existed, we return false and the stream proceeds normally.
 *
 * Stale intents (older than PENDING_ABORT_INTENT_TTL_MS) are also consumed but return false:
 * a Stop pressed 30s ago is no longer relevant — the send it was aimed at has long since either
 * started its stream (and would have consumed this) or failed.
 */
export const consumePendingAbort = async ({
  conversationId,
  userId,
  now = Date.now(),
}: {
  conversationId: string;
  userId: string;
  now?: number;
}): Promise<boolean> => {
  try {
    const deleted = await db
      .delete(aiPendingAbortIntents)
      .where(and(
        eq(aiPendingAbortIntents.conversationId, conversationId),
        eq(aiPendingAbortIntents.userId, userId),
      ))
      .returning({ createdAt: aiPendingAbortIntents.createdAt });

    if (deleted.length === 0) return false;

    // Expired intent — consume it (so it does not block the next send) but do not honour it.
    const age = now - deleted[0].createdAt.getTime();
    if (age > PENDING_ABORT_INTENT_TTL_MS) {
      loggers.ai.debug('pending-abort-intents: consumed expired intent', {
        conversationId,
        ageMs: age,
      });
      return false;
    }

    return true;
  } catch (error) {
    loggers.ai.warn('pending-abort-intents: could not consume abort intent', {
      conversationId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    // On error, do NOT abort: a failed read must not suppress a legitimate generation.
    return false;
  }
};

/**
 * Remove all pending-abort intents for a conversation+user.
 *
 * Called when a stream completes normally (the pending intent, if any, is no longer relevant).
 * Belt-and-braces cleanup: `consumePendingAbort` already DELETEs atomically, but a stream that
 * somehow bypassed `createStreamLifecycle` would leave a stale intent behind.
 */
export const clearPendingAbort = async ({
  conversationId,
  userId,
}: {
  conversationId: string;
  userId: string;
}): Promise<void> => {
  try {
    await db
      .delete(aiPendingAbortIntents)
      .where(and(
        eq(aiPendingAbortIntents.conversationId, conversationId),
        eq(aiPendingAbortIntents.userId, userId),
      ));
  } catch {
    // non-fatal — the TTL and the next consume/clear will handle it
  }
};

/**
 * Periodic sweep for intents that are never consumed.
 *
 * `consumePendingAbort` only reaps a stale row when a LATER `createStreamLifecycle` call
 * happens to land on that exact (conversation_id, user_id) pair. A conversation where the user
 * pressed Stop during preflight and never sent another message has no such later call, so its
 * intent would otherwise sit past its TTL indefinitely. Run from the generic `/api/cron/sweep-expired`
 * route (see `sweepExpiredRateLimitBuckets`, `sweepExpiredAuthHandoffTokens` for the same pattern
 * on other append-with-TTL tables) — constant-size row count returned, re-throws in production so
 * the cron handler can surface a 500, swallows and warns otherwise.
 */
export const sweepExpiredPendingAbortIntents = async (): Promise<number> => {
  try {
    const cutoff = new Date(Date.now() - PENDING_ABORT_INTENT_TTL_MS);
    const result = await db
      .delete(aiPendingAbortIntents)
      .where(lt(aiPendingAbortIntents.createdAt, cutoff));
    return result.rowCount ?? 0;
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
    loggers.ai.warn('pending-abort-intents: sweep skipped: DB unavailable');
    return 0;
  }
};
