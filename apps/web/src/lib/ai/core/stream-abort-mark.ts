import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNotNull, type SQL } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  decideAbortOutcome,
  type AbortOutcome,
  type SettleRow,
} from '@/lib/ai/core/stream-abort-decisions';
import {
  ABORT_SETTLE_POLL_MS,
  ABORT_SETTLE_TIMEOUT_MS,
} from '@/lib/ai/core/stream-horizons';
import { materializeInterruptedStream } from '@/lib/ai/core/materialize-interrupted-stream';

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
export interface MarkResult {
  /** messageIds now carrying an abort request. */
  marked: string[];
  /**
   * The write itself did not happen — the DB was unreachable, the pool was exhausted, the
   * statement timed out.
   *
   * This is NOT the same as "no row matched", and conflating them is dangerous: an empty match is
   * benign (nothing of the caller's was in flight) and the client is designed to stay SILENT about
   * it, whereas a failed write means the Stop was never recorded ANYWHERE. The generation keeps
   * running, keeps calling write tools, and keeps billing, and the user would be told nothing at
   * all while the button flips back to Send. A failure to record the request is strictly worse
   * than a failure to read it back — so it must surface, as `unconfirmed`.
   */
  failed: boolean;
}

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
}): Promise<MarkResult> => {
  const markBy = async (name: SQL | undefined): Promise<string[]> => {
    if (!name) return [];
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
  };

  // EVERY name the caller gave us is marked — a UNION, not a first-match.
  //
  // First-match precedence was a bug, and a subtle one. A client's `streamId` can be STALE (the
  // activeStreams map holds the previous turn's id until the new response headers land), and a
  // stale name is not the same as a name that resolves to nothing: during the tail of `onFinish` —
  // after the controller is unregistered but before the terminal write lands — the finished
  // stream's row STILL READS 'streaming'. So the stale name matched, precedence stopped there, and
  // the conversation was never marked. The generation that was actually running (a later turn,
  // possibly on another instance) was never asked to stop, and the caller was told `not_found` —
  // which the UI stays silent about. A silent Stop over a live generation: the cardinal sin, and
  // the exact bug this whole PR exists to eliminate.
  //
  // A union also makes this step AGREE with the local step, which already aborts every one of the
  // caller's streams on the conversation. Two steps that disagree about what a name means is how
  // that bug kept coming back in new shapes.
  //
  // Naming the conversation is what Stop means anyway — "stop whatever of MINE is generating here"
  // — and the `user_id` predicate rides every branch, so this can never reach another user.
  const names: SQL[] = [
    messageId ? eq(aiStreamSessions.messageId, messageId) : undefined,
    streamId ? eq(aiStreamSessions.streamId, streamId) : undefined,
    conversationId ? eq(aiStreamSessions.conversationId, conversationId) : undefined,
  ].filter((name): name is SQL => name !== undefined);

  // Accumulated OUTSIDE the try, because these are separate autocommitted statements: if the second
  // throws, the rows the first marked are still marked, and their owners will still stop them.
  // Reporting an empty set there would be a second lie on top of the failure.
  const marked = new Set<string>();

  try {
    for (const name of names) {
      for (const id of await markBy(name)) marked.add(id);
    }

    return { marked: [...marked], failed: false };
  } catch (error) {
    loggers.ai.warn('cross-instance abort: could not mark stream(s) for abort', {
      conversationId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return { marked: [...marked], failed: true };
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
}): Promise<MarkResult> => {
  if (messageIds.length === 0) return { marked: [], failed: false };

  try {
    const marked = await db
      .update(aiStreamSessions)
      .set({ abortRequestedAt: now })
      .where(and(
        inArray(aiStreamSessions.messageId, [...messageIds]),
        eq(aiStreamSessions.status, 'streaming'),
      ))
      .returning({ messageId: aiStreamSessions.messageId });

    return { marked: marked.map((row) => row.messageId), failed: false };
  } catch (error) {
    // `failed`, not silence. A takeover that could not even RECORD its abort request is about to
    // start a second generation beside a live one — two agents, two sets of write tools, two
    // bills. That must reach the log, not be swallowed into an empty result that reads exactly
    // like "there was nothing to stop".
    loggers.ai.warn('cross-instance abort: could not mark stream(s) for takeover abort', {
      messageIds,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return { marked: [], failed: true };
  }
};

const readSettleRows = (messageIds: readonly string[]): Promise<SettleRow[]> =>
  db
    .select({
      messageId: aiStreamSessions.messageId,
      status: aiStreamSessions.status,
      startedAt: aiStreamSessions.startedAt,
      lastHeartbeatAt: aiStreamSessions.lastHeartbeatAt,
    })
    .from(aiStreamSessions)
    .where(inArray(aiStreamSessions.messageId, [...messageIds]));

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

    const outcome = decideAbortOutcome({ requested: messageIds, rows, now: now() });
    if (outcome.stillLive.length === 0) return outcome;
    if (now() >= deadline) return outcome;

    await sleep(intervalMs);
  }
};

/**
 * Drive terminal the rows whose owner is provably gone — and, since Server Stream Durability
 * PR 3, materialize each one's parts snapshot into an honest `status: 'interrupted'` assistant
 * message rather than just wiping the session row.
 *
 * Only ever called with `decideAbortOutcome().reconcile` — rows that are still 'streaming' but
 * whose heartbeat is stale, i.e. whose process died without writing its terminal status. This is
 * the same licence `decideStreamTakeover().reconcile` already grants, and it carries the same
 * hard rule: a row that we did not stop and that STILL LOOKS ALIVE must never be written here.
 * Marking a running stream 'aborted' and wiping its parts would hide it from every subscriber and
 * destroy its only crash-recovery snapshot, while it kept on generating.
 *
 * Re-selects the full row (channelId, conversationId, userId, parts) fresh rather than threading
 * them through `decideAbortOutcome`'s messageId-only contract — that keeps this the only place
 * that needs the wider column set, and re-applies the same `status='streaming'` guard against
 * whatever landed between the caller's read and here.
 *
 * Returns the messageIds actually driven terminal — a subset of `messageIds`, never assumed to
 * be all of them. `materializeInterruptedStream` never throws but can still fail partway (and
 * report so via its own return value); a caller that reports every requested id as "reconciled"
 * regardless of whether the row read even found it, or the write actually landed, would silently
 * misreport a retryable ghost row as handled.
 */
export const reconcileDeadStreamRows = async ({
  messageIds,
}: {
  messageIds: readonly string[];
}): Promise<string[]> => {
  if (messageIds.length === 0) return [];

  let rows: { messageId: string; channelId: string; conversationId: string; userId: string; parts: unknown[]; startedAt: Date }[];
  try {
    rows = await db
      .select({
        messageId: aiStreamSessions.messageId,
        channelId: aiStreamSessions.channelId,
        conversationId: aiStreamSessions.conversationId,
        userId: aiStreamSessions.userId,
        parts: aiStreamSessions.parts,
        startedAt: aiStreamSessions.startedAt,
      })
      .from(aiStreamSessions)
      .where(and(
        inArray(aiStreamSessions.messageId, [...messageIds]),
        // Conditional on status, so a stream that terminated on its own between the read and here
        // is not retroactively relabelled.
        eq(aiStreamSessions.status, 'streaming'),
      ));
  } catch (error) {
    loggers.ai.warn('cross-instance abort: could not read dead stream row(s) for materialization', {
      messageIds,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return [];
  }

  // Concurrent, not sequential — `materializeInterruptedStream` never throws (it catches and
  // logs its own DB failures per step) and each row is independent, so there is no correctness
  // reason to serialize a mass-crash-recovery batch (potentially dozens of rows after an
  // instance dies) into N sequential round trips.
  const results = await Promise.all(rows.map(async (row) => {
    const ok = await materializeInterruptedStream(row);
    return ok ? row.messageId : null;
  }));

  return results.filter((id): id is string => id !== null);
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
    // Conditional on status so a mark written against a row that has since terminated
    // (or been taken over by a new generation) is not cleared here — the old mark is
    // harmless on a non-streaming row, and clearing it unconditionally could erase a
    // mark written between the watcher's read and this clear (#2028 item 4b).
    await db
      .update(aiStreamSessions)
      .set({ abortRequestedAt: null })
      .where(and(
        inArray(aiStreamSessions.messageId, [...messageIds]),
        eq(aiStreamSessions.status, 'streaming'),
      ));
  } catch (error) {
    loggers.ai.warn('cross-instance abort: could not clear stale abort mark(s)', {
      messageIds,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
};
