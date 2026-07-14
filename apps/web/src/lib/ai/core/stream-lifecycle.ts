import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { STREAM_MAX_LIFETIME_MS } from '@/lib/ai/core/stream-horizons';
import { ensureStreamAbortWatcher } from '@/lib/ai/core/stream-abort-watcher';
import { broadcastAiStreamStart, broadcastAiStreamComplete } from '@/lib/websocket';
import {
  streamMulticastRegistry,
  type UIMessagePart,
} from '@/lib/ai/core/stream-multicast-registry';
import { consumePendingAbort } from '@/lib/ai/core/pending-abort-intents';
import { decideCheckpoint, CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS } from '@/lib/ai/core/checkpoint-scheduler';
import {
  convergeRawParts,
  capPartsToByteBudget,
  CHECKPOINT_MAX_SERIALIZED_BYTES,
} from '@/lib/ai/core/checkpoint-serialize';

export interface StreamLifecycleParams {
  messageId: string;
  channelId: string;
  conversationId: string;
  userId: string;
  displayName: string;
  browserSessionId: string;
  /**
   * The abort registry's key for this generation. Persisted on the row so that an abort landing
   * on ANY instance can resolve the streamId it was given in the `X-Stream-Id` header back to a
   * stream — the registry that mints it is in-process, so without this the name is meaningless
   * anywhere but here. It is also the epoch the abort watcher checks, so a Stop aimed at a
   * previous attempt on this messageId can never kill the current one.
   *
   * REQUIRED, deliberately. It was optional, and both call sites happened to pass it — but nothing
   * enforced that, and an omission would not fail: the column would simply be NULL. Cross-instance
   * Stop for that stream would then degrade silently, with no error at build time and none at run
   * time either. The type is the only thing that can catch this, so let it.
   */
  streamId: string;
  /**
   * Whether the conversation is explicitly shared. Rides the stream_start broadcast so
   * page members can tell, without asking, whether a stream is theirs to watch — see
   * AiStreamStartPayload.isShared.
   */
  isShared?: boolean;
}

export interface StreamLifecycleHandle {
  finish: (aborted: boolean) => void;
  pushPart: (part: UIMessagePart) => void;
  getBufferedParts: () => UIMessagePart[];
  /**
   * True when a pending-abort intent was consumed immediately after INSERT time (#2028 item 1).
   * The row was updated to 'aborted' directly; the caller should abort the controller so
   * streamText never starts, and skip broadcastAiStreamStart.
   */
  preAborted: boolean;
}

// Batch DB writes rather than persisting on every token. Cadence decision lives in
// checkpoint-scheduler.ts (decideCheckpoint) — dirty-flush throttled to this interval, with an
// immediate bypass on tool-boundary parts. See CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS there.

/**
 * How often the generation writes `lastHeartbeatAt`.
 *
 * This is a real timer, and it has to be: the parts checkpoint above cannot serve as
 * a heartbeat, because a stream sitting in a long tool call (sandbox exec, deep
 * research, a slow MCP tool) pushes NO parts for minutes at a time. Riding the
 * checkpoint would declare a perfectly healthy stream dead — it would disappear from
 * `/active-streams` so no client could attach, and the next send would fail to abort
 * it and would generate alongside it.
 *
 * Comfortably several beats inside STREAM_HEARTBEAT_STALE_MS, and it is one tiny
 * single-row UPDATE per interval per in-flight stream.
 */
const HEARTBEAT_INTERVAL_MS = 20 * 1000;

/**
 * Hard ceiling on how long a lifecycle will keep beating.
 *
 * A backstop, not a policy. `finish()` clears the interval, and every generation path
 * reaches it — but if one ever did not, an unbounded heartbeat would be strictly worse
 * than no heartbeat: the row would look *live forever*, so it could never be reconciled,
 * could never be taken over (the abort registry evicts its entry after MAX_STREAM_AGE_MS
 * = 10 min, after which the abort is a no-op), and would be served to clients as an
 * unjoinable phantom stream for the life of the process. Capping the beat converts that
 * immortal ghost back into an ordinary stale row, which the next takeover reconciles.
 *
 * Shares STREAM_MAX_LIFETIME_MS with the abort and multicast registries — deliberately, so
 * the three cannot drift apart again. When they disagreed (registries at 10 minutes, this
 * at an hour), a long generation still alive at minute 15 was correctly reported as running
 * while no client could join it and its Stop button had already become a no-op.
 *
 * A generation that outlives the cap stops beating while still alive, and ~2 minutes later
 * its row reads as stale — so the next send on that conversation would drive a LIVE row
 * terminal, the lie `decideStreamTakeover` exists to avoid. An hour buys enough headroom
 * that the trade is academic, while still bounding a leaked interval.
 *
 * The parts checkpoint in `pushPart` obeys this same deadline, and MUST. It writes
 * lastHeartbeatAt too, so an uncapped checkpoint let any still-chattering generation refresh
 * its own liveness forever — reinstating the immortal ghost this cap exists to kill, on the
 * one stream most likely to hit it. (An earlier version of this comment had it exactly
 * backwards, calling the checkpoint beat a mitigation. It was the hole.)
 */
const MAX_HEARTBEAT_MS = STREAM_MAX_LIFETIME_MS;

export const createStreamLifecycle = async (
  params: StreamLifecycleParams,
): Promise<StreamLifecycleHandle> => {
  const { messageId, channelId, conversationId, userId, displayName, browserSessionId, isShared, streamId } = params;

  // Lazily started, and it stops itself when this instance owns no more streams. An instance that
  // never generates never polls.
  ensureStreamAbortWatcher();

  try {
    streamMulticastRegistry.register(messageId, {
      pageId: channelId,
      userId,
      displayName,
      conversationId,
      browserSessionId,
    });
  } catch (error) {
    loggers.ai.warn('stream-lifecycle: registry.register threw', {
      messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }

  // Captured once so the DB row and the broadcast agree on the stream's start
  // time — remote surfaces stamp synthesized bubbles with this value.
  const startedAt = new Date();

  try {
    await db
      .insert(aiStreamSessions)
      .values({
        messageId,
        channelId,
        conversationId,
        userId,
        displayName,
        browserSessionId,
        streamId,
        status: 'streaming',
        startedAt,
        lastHeartbeatAt: startedAt,
      })
      .onConflictDoUpdate({
        target: aiStreamSessions.messageId,
        set: {
          channelId,
          conversationId,
          userId,
          displayName,
          browserSessionId,
          streamId,
          status: 'streaming',
          startedAt,
          lastHeartbeatAt: startedAt,
          completedAt: null,
          // A re-registered messageId gets a fresh (empty) in-memory buffer
          // above — the DB snapshot must reset with it, or a bootstrap
          // between here and the first checkpoint would serve the prior
          // attempt's stale parts as if they were a prefix of this attempt.
          parts: [],
          // Resets alongside parts for the same reason — a stale count from the previous
          // attempt would make the client under-skip on rejoin (see rawPartsCount's docblock
          // in the schema).
          rawPartsCount: 0,
          // An abort request aimed at the PREVIOUS generation on this messageId must not be
          // inherited by this one — the new stream would be killed the instant the abort watcher
          // next ticked, by a Stop the user pressed on something else entirely. Silent, and
          // catastrophic; there is a source-level test asserting this line still exists.
          //
          // The watcher independently refuses to act on a mark whose streamId names a superseded
          // generation, so this is the braces to that belt.
          abortRequestedAt: null,
        },
      });
  } catch (error) {
    loggers.ai.warn('stream-lifecycle: aiStreamSessions INSERT failed', {
      messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }

  // ── POST-INSERT PENDING-ABORT CHECK (#2028 item 1) ────────────────────────────────────────
  //
  // A Stop pressed during the route's preflight (auth, permissions, context assembly: 0.5-3s of
  // TTFB) — or landing in the narrow gap between entering this function and the INSERT above
  // resolving — found no row to mark and wrote a durable pending-abort intent instead. Checking
  // once here, right after the row exists, catches BOTH cases: nothing else consumes the intent
  // in between, and it persists (bounded by its TTL) regardless of when it was written. If one
  // exists, honour it: flip the just-inserted row to 'aborted' and return a pre-finished handle.
  // The caller aborts the controller so streamText never starts.
  //
  // NOT fully closed, same as the KNOWN RACE in chat/route.ts: `recordPendingAbort`'s write runs
  // on an independent connection with no shared lock or transaction, so it can commit-visible
  // AFTER this consume already ran — a single-digit-millisecond commit-ordering skew, not a logic
  // bug. In that sliver, the Stop is lost (the generation it targeted runs to completion) and the
  // orphaned intent then wrongly pre-aborts the user's NEXT, unrelated send within the 30s TTL.
  // Bounded and self-healing (no double-billing, TTL expiry), so a same-transaction check or
  // advisory lock is not warranted here — but do not read this as the window being absent.
  const preAborted = await consumePendingAbort({ conversationId, userId });

  if (preAborted) {
    loggers.ai.info('stream-lifecycle: consumed pending-abort intent, stream pre-aborted', {
      messageId,
      conversationId,
    });

    const abortedAt = new Date();
    try {
      await db
        .update(aiStreamSessions)
        .set({
          status: 'aborted',
          completedAt: abortedAt,
          parts: [],
          rawPartsCount: 0,
          abortRequestedAt: null,
        })
        .where(eq(aiStreamSessions.messageId, messageId));
    } catch (error) {
      loggers.ai.warn('stream-lifecycle: pre-aborted UPDATE failed', {
        messageId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }

    // Nothing has subscribed yet — registration just happened and broadcastAiStreamStart has not
    // fired — so evicting the entry here is a plain cleanup, not a notification to a live client.
    try {
      streamMulticastRegistry.finish(messageId, true);
    } catch (error) {
      loggers.ai.warn('stream-lifecycle: registry.finish threw during pre-abort', {
        messageId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }

    // No broadcast, no heartbeat. A no-op handle whose finish is idempotent.
    const noop = (): void => {};
    return { finish: noop, pushPart: noop, getBufferedParts: () => [], preAborted: true };
  }

  broadcastAiStreamStart({
    messageId,
    pageId: channelId,
    conversationId,
    startedAt: startedAt.toISOString(),
    isShared: isShared === true,
    triggeredBy: { userId, displayName, browserSessionId },
  }).catch(() => {});

  let finished = false;
  // True when the in-memory buffer holds content not yet reflected in the last checkpoint
  // write — decideCheckpoint's dirty gate.
  let dirty = false;
  let lastPersistAt = startedAt.getTime();
  // Tracks the in-flight periodic write so finish() can await it before issuing
  // its own final write — otherwise a slow periodic write could resolve AFTER
  // finish()'s write and clobber the final parts with a stale snapshot.
  let persistInFlight: Promise<void> | null = null;
  // One warning per stream, not one per checkpoint — a reply that stays over the cap for its
  // whole remaining run would otherwise log on every tick.
  let hasWarnedSizeCap = false;

  const persistBufferedParts = (parts: UIMessagePart[]): Promise<void> => {
    // The RAW count, before convergence/capping — the one thing the merged/capped `parts`
    // column below cannot answer for a rejoining client. See rawPartsCount's docblock on the
    // schema for why this must travel separately from parts.length.
    const rawPartsCount = parts.length;
    const { parts: shaped, wasCapped } = capPartsToByteBudget(convergeRawParts(parts));
    if (wasCapped && !hasWarnedSizeCap) {
      hasWarnedSizeCap = true;
      loggers.ai.warn('stream-lifecycle: parts snapshot at or over the serialized size cap', {
        messageId,
        maxBytes: CHECKPOINT_MAX_SERIALIZED_BYTES,
      });
    }
    const attempt = (async () => {
      try {
        await db
          .update(aiStreamSessions)
          .set({ parts: shaped, rawPartsCount, lastHeartbeatAt: new Date() })
          .where(eq(aiStreamSessions.messageId, messageId));
      } catch (error) {
        loggers.ai.warn('stream-lifecycle: aiStreamSessions parts persist failed', {
          messageId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    })();
    persistInFlight = attempt;
    void attempt.finally(() => {
      if (persistInFlight === attempt) persistInFlight = null;
    });
    return attempt;
  };

  // Liveness beat. Independent of pushPart on purpose — see HEARTBEAT_INTERVAL_MS.
  // Touches only lastHeartbeatAt, so it can never race the parts writes (and a tick that
  // lands after the terminal write cannot resurrect the row: every reader filters
  // status='streaming').
  const heartbeatDeadline = startedAt.getTime() + MAX_HEARTBEAT_MS;
  const heartbeat = setInterval(() => {
    if (finished || Date.now() > heartbeatDeadline) {
      clearInterval(heartbeat);
      return;
    }
    void db
      .update(aiStreamSessions)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(aiStreamSessions.messageId, messageId))
      .catch((error: unknown) => {
        loggers.ai.warn('stream-lifecycle: heartbeat write failed', {
          messageId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      });
  }, HEARTBEAT_INTERVAL_MS);
  // Never hold the process open for a heartbeat.
  heartbeat.unref?.();

  // Runs the checkpoint decision and, if eligible, kicks off the persist. Shared by pushPart
  // (isToolBoundary reflects the part just pushed) and the 1s interval below (always false —
  // it isn't tied to any specific part; it exists so a DIRTY buffer with no further pushPart
  // calls — e.g. sitting inside a long tool call after the tool-input-available part landed —
  // still gets flushed instead of staying frozen until the tool call ends.
  const maybeCheckpoint = (isToolBoundary: boolean): void => {
    if (finished) return;
    const now = Date.now();
    const shouldFlush = decideCheckpoint({
      dirty,
      isToolBoundary,
      persistInFlight: persistInFlight !== null,
      lastPersistAt,
      heartbeatDeadline,
      now,
    });
    if (!shouldFlush) return;

    // The registry entry is the source of the snapshot. Once it is gone — evicted at the
    // horizon, or deleted by a finish() that raced us — `getBufferedParts` returns `[]`
    // meaning "NO ENTRY", not "no content". Serializing that would overwrite the real parts
    // snapshot with nothing, destroying exactly the crash-recovery state it exists to provide:
    // a client restoring mid-stream content after the originator's process dies.
    if (streamMulticastRegistry.getMeta(messageId) === undefined) return;

    dirty = false;
    lastPersistAt = now;
    persistBufferedParts(streamMulticastRegistry.getBufferedParts(messageId));
  };

  // Independent of pushPart on purpose — see maybeCheckpoint's docblock above. Obeys the same
  // MAX_HEARTBEAT_MS horizon as the heartbeat interval and self-clears past it for the same
  // reason: an interval that kept ticking forever on an abandoned-cap lifecycle would be a
  // leak, even though decideCheckpoint would keep declining to flush past the deadline anyway.
  const checkpointInterval = setInterval(() => {
    if (finished || Date.now() > heartbeatDeadline) {
      clearInterval(checkpointInterval);
      return;
    }
    maybeCheckpoint(false);
  }, CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS);
  // Never hold the process open for a checkpoint tick.
  checkpointInterval.unref?.();

  const finish = (aborted: boolean): void => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    clearInterval(checkpointInterval);

    const priorPersist = persistInFlight;

    try {
      streamMulticastRegistry.finish(messageId, aborted);
    } catch (error) {
      loggers.ai.warn('stream-lifecycle: registry.finish threw', {
        messageId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }

    void (async () => {
      // Wait out any in-flight periodic persist so this final write always lands last.
      if (priorPersist) await priorPersist;
      try {
        await db
          .update(aiStreamSessions)
          .set({
            status: aborted ? 'aborted' : 'complete',
            completedAt: new Date(),
            // The only reader of this column (GET /api/ai/chat/active-streams)
            // filters status='streaming' — once the row leaves that status no
            // code ever reads its parts again, and the full message content is
            // already durably saved via the normal message-persistence path.
            // Clearing it here avoids keeping an unbounded, unpruned copy of
            // every AI reply's content sitting in this table indefinitely.
            parts: [],
            rawPartsCount: 0,
          })
          .where(eq(aiStreamSessions.messageId, messageId));
      } catch (error) {
        loggers.ai.warn('stream-lifecycle: aiStreamSessions UPDATE failed', {
          messageId,
          aborted,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    })();

    broadcastAiStreamComplete({
      messageId,
      pageId: channelId,
      conversationId,
      aborted,
    }).catch(() => {});
  };

  const pushPart = (part: UIMessagePart): void => {
    // finish() already deleted the registry entry and issued the final
    // write; a part pushed after that point would still trip the checkpoint
    // below with an empty getBufferedParts() snapshot, racing the final
    // write with no ordering guarantee against it.
    if (finished) return;

    try {
      streamMulticastRegistry.push(messageId, part);
    } catch (error) {
      // one bad chunk must not interrupt the stream — log so the swallow stays observable
      loggers.ai.warn('stream-lifecycle: registry.push threw', {
        messageId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }

    dirty = true;
    // A tool call starting or finishing is a boundary a rejoining client should see
    // immediately — see decideCheckpoint. Matched against the `tool-` prefix explicitly
    // (not "anything but text") so a future part type chunkToPart.ts starts forwarding
    // (reasoning, source, file — its docblock names these as future waves) doesn't silently
    // start bypassing the dirty-flush throttle on every chunk.
    maybeCheckpoint(part.type.startsWith('tool-'));
  };

  const getBufferedParts = (): UIMessagePart[] =>
    streamMulticastRegistry.getBufferedParts(messageId);

  return { finish, pushPart, getBufferedParts, preAborted: false };
};
