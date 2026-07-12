import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNotNull } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  decideAbortOutcome,
  type AbortOutcome,
  type SettleRow,
} from '@/lib/ai/core/stream-abort-decisions';

/**
 * The cross-instance half of Stop.
 *
 * The abort registry is in-process. Prod runs multiple web instances. So an abort that lands on
 * an instance which does not own the stream has nothing to abort — and because streams are
 * server-owned and disconnect-immune, cancelling the client's fetch stops NOTHING. The agent kept
 * generating, kept calling write tools, and kept billing, while the button flipped back to Send.
 *
 * This module writes the abort request onto the stream's row, where the owning instance's watcher
 * (`stream-abort-watcher.ts`) will find it. Postgres is the coordination channel — the same one
 * the heartbeat and the distributed rate limiter already use. There is no new transport, no new
 * service identity, and nothing on a wire that could be forged.
 *
 * ── SECURITY: THE `WHERE` CLAUSE *IS* THE AUTHORIZATION ─────────────────────────────────────────
 *
 * A broadcast-style abort would have to be re-authorized on receipt, because a receiving instance
 * cannot trust a payload's claim about who is allowed to stop what. Honouring such a claim
 * unchecked would be a remote kill switch for other users' generations.
 *
 * There is no such payload here. `markAbortRequested` can only mark a row it can already SELECT as
 * the caller's own, because the caller's `user_id` is a predicate of the UPDATE itself. A user who
 * names another user's messageId updates ZERO rows. The forged-abort case is not blocked, it is
 * unrepresentable — and the owner independently re-reads `user_id` from its own row before it
 * aborts anything.
 *
 * The one exception is `markAbortRequestedAsOwner`, below. Read its docblock before using it.
 */

/** Bounded, because a Stop that hangs is a Stop the user presses again. */
export const ABORT_SETTLE_TIMEOUT_MS = 2_000;
/** Comfortably tighter than the watcher's ~1s tick, so a confirmation is rarely missed by a beat. */
export const ABORT_SETTLE_POLL_MS = 250;
/**
 * The takeover's budget. Shorter than a user-facing Stop: this one is spent on a SEND, and the
 * user is waiting for their message to go out.
 */
export const TAKEOVER_SETTLE_TIMEOUT_MS = 1_500;

const sleepReal = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the owning instance to abort the caller's OWN in-flight stream(s).
 *
 * Named by messageId, streamId, or conversationId — mirroring the abort endpoint's precedence.
 * `streamId` is resolvable here (and not only in the minting process's memory) because it is now
 * persisted on the row; it is the name the client holds from the `X-Stream-Id` response header,
 * and so the one Stop most often uses.
 *
 * Returns the messageIds actually marked. Zero means "no in-flight stream of YOURS matched" — a
 * caller must not distinguish "not yours" from "not there", and neither does this function: doing
 * so would confirm the existence of another user's stream.
 */
export const markAbortRequested = async ({
  messageId,
  streamId,
  conversationId,
  userId,
  now = new Date(),
}: {
  messageId?: string;
  streamId?: string;
  conversationId?: string;
  userId: string;
  now?: Date;
}): Promise<string[]> => {
  const name = messageId
    ? eq(aiStreamSessions.messageId, messageId)
    : streamId
      ? eq(aiStreamSessions.streamId, streamId)
      : conversationId
        ? eq(aiStreamSessions.conversationId, conversationId)
        : undefined;

  if (!name) return [];

  try {
    const marked = await db
      .update(aiStreamSessions)
      .set({ abortRequestedAt: now })
      .where(and(
        name,
        // SECURITY — the caller's own streams only. Do not remove, do not "generalise", and do
        // not add a variant of this helper without it. This single predicate is what stands
        // between Stop and a remote kill switch for every other user's generation.
        eq(aiStreamSessions.userId, userId),
        eq(aiStreamSessions.status, 'streaming'),
      ))
      .returning({ messageId: aiStreamSessions.messageId });

    return marked.map((row) => row.messageId);
  } catch (error) {
    loggers.ai.warn('cross-instance abort: could not mark stream(s) for abort', {
      conversationId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return [];
  }
};

/**
 * Mark rows for abort as the STREAM'S OWNER rather than as the caller — no user predicate.
 *
 * FOR THE TAKEOVER PATH ONLY (`stream-takeover.ts`), and it grants no privilege that path did not
 * already have: it is the exact analogue of the abort it already performs, which passes
 * `row.userId` and not the caller's for precisely this reason. A second send on a SHARED
 * conversation must be able to take over a co-member's generation, or user B's send leaves user
 * A's agent running — still calling tools, still editing pages, still billing — while B's starts
 * beside it. The caller's right to write to the conversation is established upstream, by the
 * route, before this is ever reached.
 *
 * A user-facing Stop must NEVER call this. Use `markAbortRequested`, whose WHERE clause carries
 * the caller's id. If you find yourself wanting an unfiltered "mark by messageId" helper for a
 * client-driven path, you are about to hand anyone holding a messageId the ability to stop
 * anyone's generation.
 */
export const markAbortRequestedAsOwner = async ({
  messageIds,
  now = new Date(),
}: {
  messageIds: readonly string[];
  now?: Date;
}): Promise<string[]> => {
  if (messageIds.length === 0) return [];

  try {
    const marked = await db
      .update(aiStreamSessions)
      .set({ abortRequestedAt: now })
      .where(and(
        inArray(aiStreamSessions.messageId, [...messageIds]),
        eq(aiStreamSessions.status, 'streaming'),
      ))
      .returning({ messageId: aiStreamSessions.messageId });

    return marked.map((row) => row.messageId);
  } catch (error) {
    loggers.ai.warn('cross-instance abort: could not mark stream(s) for takeover abort', {
      messageIds,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return [];
  }
};

const readSettleRows = async (messageIds: readonly string[]): Promise<SettleRow[]> => {
  const rows = await db
    .select({
      messageId: aiStreamSessions.messageId,
      status: aiStreamSessions.status,
      startedAt: aiStreamSessions.startedAt,
      lastHeartbeatAt: aiStreamSessions.lastHeartbeatAt,
    })
    .from(aiStreamSessions)
    .where(inArray(aiStreamSessions.messageId, [...messageIds]));

  return rows;
};

/**
 * Wait for marked streams to actually stop, and say honestly what happened.
 *
 * Effects are INJECTED (`readRows`, `sleep`, `now`) so this can be driven end to end in a test
 * with a real in-memory row store rather than a mocked DB module — a mocked one would happily
 * pass while the real query was wrong.
 *
 * Every verdict is delegated to `decideAbortOutcome`, which is where the subtle part lives: a
 * timeout is NOT the same as "still running" (a crashed owner never settles its row either), so a
 * stale heartbeat is read as "stopped, and the row needs reconciling" and never as an alarm.
 */
export const awaitAbortSettled = async ({
  messageIds,
  timeoutMs = ABORT_SETTLE_TIMEOUT_MS,
  intervalMs = ABORT_SETTLE_POLL_MS,
  readRows = readSettleRows,
  sleep = sleepReal,
  now = Date.now,
}: {
  messageIds: readonly string[];
  timeoutMs?: number;
  intervalMs?: number;
  readRows?: (messageIds: readonly string[]) => Promise<SettleRow[]>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<AbortOutcome> => {
  if (messageIds.length === 0) {
    return decideAbortOutcome({ requested: [], rows: [], now: now() });
  }

  const deadline = now() + timeoutMs;
  let outcome = decideAbortOutcome({ requested: messageIds, rows: [], now: now() });

  // Loop, rather than a single sleep-then-check: the common case is the owner picking the mark up
  // on its next tick, and returning the moment it does keeps Stop feeling immediate.
  for (;;) {
    let rows: SettleRow[];
    try {
      rows = await readRows(messageIds);
    } catch (error) {
      // The streams may well have stopped; we simply cannot see it. Say that, rather than
      // claiming either outcome.
      loggers.ai.warn('cross-instance abort: could not read back stream status', {
        messageIds,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return { aborted: [], reconcile: [], stillLive: [...messageIds], code: 'unconfirmed' };
    }

    outcome = decideAbortOutcome({ requested: messageIds, rows, now: now() });
    if (outcome.stillLive.length === 0) return outcome;
    if (now() >= deadline) return outcome;

    await sleep(intervalMs);
  }
};

/**
 * Drive terminal the rows whose owner is provably gone.
 *
 * Only ever called with `decideAbortOutcome().reconcile` — rows that are still 'streaming' but
 * whose heartbeat is stale, i.e. whose process died without writing its terminal status. This is
 * the same licence `decideStreamTakeover().reconcile` already grants, and it carries the same
 * hard rule: a row that we did not stop and that STILL LOOKS ALIVE must never be written here.
 * Marking a running stream 'aborted' and wiping its parts would hide it from every subscriber and
 * destroy its only crash-recovery snapshot, while it kept on generating.
 */
export const reconcileDeadStreamRows = async ({
  messageIds,
}: {
  messageIds: readonly string[];
}): Promise<void> => {
  if (messageIds.length === 0) return;

  try {
    await db
      .update(aiStreamSessions)
      .set({ status: 'aborted', completedAt: new Date(), parts: [], abortRequestedAt: null })
      .where(and(
        inArray(aiStreamSessions.messageId, [...messageIds]),
        // Conditional on status, so a stream that terminated on its own between the read and here
        // is not retroactively relabelled.
        eq(aiStreamSessions.status, 'streaming'),
      ));
  } catch (error) {
    loggers.ai.warn('cross-instance abort: could not reconcile dead stream row(s)', {
      messageIds,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
};

/**
 * Read the rows this instance has been asked to abort.
 *
 * Scoped to the messageIds this process actually owns: a mark for another instance's stream is
 * none of our business, and must be left untouched for the instance that can act on it.
 */
export const readMarkedStreams = async ({
  messageIds,
}: {
  messageIds: readonly string[];
}): Promise<{ messageId: string; streamId: string | null; userId: string }[]> => {
  if (messageIds.length === 0) return [];

  return db
    .select({
      messageId: aiStreamSessions.messageId,
      streamId: aiStreamSessions.streamId,
      // The OWNER, straight from our own row. Never a claim made by whoever requested the abort.
      userId: aiStreamSessions.userId,
    })
    .from(aiStreamSessions)
    .where(and(
      inArray(aiStreamSessions.messageId, [...messageIds]),
      eq(aiStreamSessions.status, 'streaming'),
      isNotNull(aiStreamSessions.abortRequestedAt),
    ));
};

/**
 * Clear a mark that can never be actioned — one written against a generation that has already
 * been superseded on this row. Without this the watcher re-reads it on every tick, forever.
 *
 * Only ever called with `decideWatcherActions().clear`, which is a strictly narrower set than
 * "marks we saw": a mark belonging to ANOTHER instance is never cleared here, because clearing it
 * would consume the abort request without performing the abort — and the user's Stop would
 * silently do nothing, which is the original bug wearing a different hat.
 */
export const clearAbortMarks = async ({
  messageIds,
}: {
  messageIds: readonly string[];
}): Promise<void> => {
  if (messageIds.length === 0) return;

  try {
    await db
      .update(aiStreamSessions)
      .set({ abortRequestedAt: null })
      .where(inArray(aiStreamSessions.messageId, [...messageIds]));
  } catch (error) {
    loggers.ai.warn('cross-instance abort: could not clear stale abort mark(s)', {
      messageIds,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
};
