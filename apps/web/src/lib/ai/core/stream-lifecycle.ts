import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { STREAM_MAX_LIFETIME_MS } from '@/lib/ai/core/stream-horizons';
import { ensureStreamAbortWatcher } from '@/lib/ai/core/stream-abort-watcher';
import { broadcastAiStreamStart, broadcastAiStreamComplete } from '@/lib/websocket';
import { conversationEvents } from '@/lib/websocket/conversation-events';
import type { UIMessageChunk } from 'ai';
import {
  streamChannelRegistry,
  type UIMessagePart,
} from '@/lib/ai/core/stream-channel-registry';
import type { StreamChannel } from '@/lib/ai/core/stream-channel';
import { foldChunksToParts } from '@/lib/ai/streams/foldChunksToParts';
import { consumePendingAbort } from '@/lib/ai/core/pending-abort-intents';
import { decideCheckpoint, CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS } from '@/lib/ai/core/checkpoint-scheduler';

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
  /**
   * This generation's frame channel. The pump appends to it; the HTTP response, the SSE
   * joiner, and this lifecycle's own checkpoint all subscribe to the SAME object.
   *
   * Replaces `pushPart`. Nothing re-derives a second copy of the stream any more: what the
   * response body carries and what the checkpoint persists are now the same frames, folded
   * by the SDK's own reduction rather than by a hand-written projection.
   */
  channel: StreamChannel;
  /**
   * Everything captured so far, folded to parts.
   *
   * Async because the fold reconstructs partially-streamed tool input with
   * `parsePartialJson`. Was `getBufferedParts(): UIMessagePart[]`.
   */
  getParts: () => Promise<UIMessagePart[]>;
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
 * The parts checkpoint driven by the channel subscription obeys this same deadline, and
 * MUST. It writes
 * lastHeartbeatAt too, so an uncapped checkpoint let any still-chattering generation refresh
 * its own liveness forever — reinstating the immortal ghost this cap exists to kill, on the
 * one stream most likely to hit it. (An earlier version of this comment had it exactly
 * backwards, calling the checkpoint beat a mitigation. It was the hole.)
 */
const MAX_HEARTBEAT_MS = STREAM_MAX_LIFETIME_MS;

/**
 * The tool-family chunk types that are durability boundaries — every one except
 * `tool-input-delta`. See `isDurabilityBoundary` for why this is enumerated rather than
 * prefix-matched.
 */
const TOOL_BOUNDARY_CHUNK_TYPES: ReadonlySet<string> = new Set([
  'tool-input-start',
  'tool-input-available',
  'tool-input-error',
  'tool-output-available',
  'tool-output-error',
  'tool-output-denied',
  'tool-approval-request',
]);

export const createStreamLifecycle = async (
  params: StreamLifecycleParams,
): Promise<StreamLifecycleHandle> => {
  const { messageId, channelId, conversationId, userId, displayName, browserSessionId, isShared, streamId } = params;

  // Lazily started, and it stops itself when this instance owns no more streams. An instance that
  // never generates never polls.
  ensureStreamAbortWatcher();

  // Opened BEFORE anything can append, and returned on the handle, so the pump and every
  // subscriber address one object. `open` finishes any previous channel on this messageId
  // (the retry/takeover path) rather than stranding its subscribers.
  //
  // Not wrapped in try/catch, unlike the registration it replaces: that catch existed
  // because a failed registration still left a usable lifecycle, whereas a lifecycle with no
  // channel has nowhere to put frames and would swallow the entire generation silently.
  // Failing loudly here is strictly better than returning a handle that cannot record.
  const channel = streamChannelRegistry.open(messageId, {
    pageId: channelId,
    userId,
    displayName,
    conversationId,
    browserSessionId,
  });

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

    // Nothing has subscribed yet — the channel opened a moment ago and broadcastAiStreamStart
    // has not fired — so closing it here is a plain cleanup, not a notification to a live client.
    try {
      streamChannelRegistry.close(messageId, true);
    } catch (error) {
      loggers.ai.warn('stream-lifecycle: channel close threw during pre-abort', {
        messageId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }

    // No broadcast, no heartbeat. The handle still carries the (already finished) channel
    // rather than a no-op: a caller that pumps into it regardless gets frames REFUSED by a
    // finished channel, which is observable, instead of a `pushPart: noop` that accepted the
    // whole generation and dropped it on the floor.
    const noop = (): void => {};
    return {
      finish: noop,
      channel,
      getParts: async () => [],
      preAborted: true,
    };
  }

  const streamStartPayload = {
    messageId,
    pageId: channelId,
    conversationId,
    startedAt: startedAt.toISOString(),
    isShared: isShared === true,
    triggeredBy: { userId, displayName, browserSessionId },
  };
  broadcastAiStreamStart(streamStartPayload).catch(() => {});
  // Transitional conv-room mirror (Agent-Session SSoT epic, Phase 2): the
  // same event also reaches `conv:<conversationId>` subscribers, whose room
  // membership already encodes the isShared/owner authz the page-room leg
  // has to carry as a payload flag. The page-room leg stays until the legacy
  // client subscription is deleted.
  conversationEvents
    .streamLifecycleMirror(conversationId, 'chat:stream_start', streamStartPayload)
    .catch(() => {});

  let finished = false;
  // True when the in-memory buffer holds content not yet reflected in the last checkpoint
  // write — decideCheckpoint's dirty gate.
  let dirty = false;
  let lastPersistAt = startedAt.getTime();
  // Tracks the in-flight periodic write so finish() can await it before issuing
  // its own final write — otherwise a slow periodic write could resolve AFTER
  // finish()'s write and clobber the final parts with a stale snapshot.
  let persistInFlight: Promise<void> | null = null;

  /**
   * Persist a checkpoint of the stream so far.
   *
   * The whole convergence/capping apparatus this replaces existed to make ONE jsonb column
   * serve as a joiner's seed: `convergeRawPartsWithOrigins` merged raw frames,
   * `capPartsToByteBudget` bounded the result, and `rawPartsCount` told the client how many
   * raw frames the merged snapshot already reflected so it could skip that many on replay.
   * Every part of that was in service of a splice the seq cursor now makes unnecessary —
   * a joiner asks for `fromSeq` and gets exactly those frames.
   *
   * So the snapshot is simply the SDK's own reduction of everything captured, and it is now
   * lossless where it used to drop reasoning, files, sources, step boundaries and the routes'
   * own `data-*` parts.
   *
   * KNOWN TRUNCATION, carried forward deliberately. `channel.getFrames()` returns what the
   * memory ring still holds, so once a very long reply evicts its oldest frames this snapshot
   * silently loses its beginning. The code this replaces truncated too (`capPartsToByteBudget`
   * dropped the oldest merged content), so this is not a regression — but the ring's frame cap
   * is reachable by a long multi-step agent run, which is more reachable than the old byte cap
   * was. It is not fixed here because the fix is the durable frame log: once frames are read
   * from Postgres rather than from memory, eviction stops being truncation at all. Tracked on
   * the epic board rather than left as a comment nobody is accountable for. `rawPartsCount` is still written (as the frame count) because the
   * column is NOT NULL and older clients still read it; it is dropped with the parts column
   * in the contract leaf.
   */
  const persistCheckpoint = (frames: readonly UIMessageChunk[]): Promise<void> => {
    const frameCount = frames.length;
    const attempt = (async () => {
      try {
        const shaped = await foldChunksToParts(frames);
        await db
          .update(aiStreamSessions)
          .set({ parts: shaped, rawPartsCount: frameCount, lastHeartbeatAt: new Date() })
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

  // Liveness beat. Independent of the frame flow on purpose — see HEARTBEAT_INTERVAL_MS.
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

  // Runs the checkpoint decision and, if eligible, kicks off the persist. Shared by the
  // channel subscription
  // (isToolBoundary reflects the part just pushed) and the 1s interval below (always false —
  // it isn't tied to any specific frame; it exists so a DIRTY buffer with no further frames
  // calls — e.g. sitting inside a long tool call after the tool-input-available part landed —
  // still gets flushed instead of staying frozen until the tool call ends.
  const maybeCheckpoint = (isToolBoundary: boolean): void => {
    // Both current call sites (the channel subscription, the checkpointInterval tick) check
    // `finished` before calling in, so this is unreachable today — kept as defense in
    // depth rather than removed. A part flushed after finish() has already deleted the
    // registry entry and issued the final write races that write with no ordering
    // guarantee against it; that failure mode has enough documented history elsewhere in
    // this file that a future third caller forgetting the same check should fail closed,
    // not silently reopen it.
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

    // Only the lifecycle that CURRENTLY owns the registry entry may checkpoint.
    //
    // Identity, not existence. The pre-inversion guard asked `getMeta(messageId) === undefined`
    // because the snapshot was fetched BY messageId, so an evicted entry returned `[]` — which
    // would have overwritten a real snapshot with nothing. That hazard is gone: this lifecycle
    // closes over its own `channel`, so its frames survive eviction.
    //
    // What remains is supersession, which the old shape could not see at all. A retry or
    // takeover opens a NEW channel on the same messageId; the old lifecycle's `finished` flag
    // is still false and its checkpoint interval is still armed, so it would go on writing its
    // stale frames over the new generation's row. Comparing identity stops that, and still
    // covers horizon eviction (`get` returns undefined, which is also not `channel`).
    if (streamChannelRegistry.get(messageId) !== channel) return;

    dirty = false;
    lastPersistAt = now;
    persistCheckpoint(channel.getFrames());
  };

  // Independent of the frame flow on purpose — see maybeCheckpoint's docblock. Obeys the same
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
      streamChannelRegistry.close(messageId, aborted);
    } catch (error) {
      loggers.ai.warn('stream-lifecycle: channel close threw', {
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

    const streamCompletePayload = {
      messageId,
      pageId: channelId,
      conversationId,
      aborted,
    };
    broadcastAiStreamComplete(streamCompletePayload).catch(() => {});
    // Transitional conv-room mirror — see the stream_start emission above.
    conversationEvents
      .streamLifecycleMirror(conversationId, 'chat:stream_complete', streamCompletePayload)
      .catch(() => {});
  };

  /**
   * A frame worth checkpointing IMMEDIATELY rather than waiting out the dirty-flush throttle.
   *
   * A rejoining client should see a tool call start or finish, a route-written data part, or
   * an error as soon as it happens — those are the frames that change what the UI shows,
   * whereas a text delta is one of thousands. This is the successor to the `isToolPart(part)`
   * bypass, restated over chunk types now that the checkpoint reads frames.
   *
   * Deliberately an explicit allow-list rather than "anything that is not a text delta":
   * reasoning streams token-by-token exactly like text, so a negative check would bypass the
   * throttle on every reasoning frame of a long chain-of-thought and turn the checkpoint back
   * into a per-token write.
   *
   * WHICH IS WHY THE TOOL FAMILY IS ENUMERATED AND NOT PREFIX-MATCHED. `tool-input-delta`
   * carries the model's tool ARGUMENTS token by token — the same shape as a text or reasoning
   * delta, and just as numerous for a tool call with a large input. A `startsWith('tool-')`
   * check therefore made every one of those frames a boundary, which is the exact per-token
   * write the paragraph above rejects: `persistInFlight` serializes those writes but does not
   * throttle them, so the checkpoint would rewrite the whole parts array back-to-back for the
   * length of the argument stream (review finding — coderabbitai, PR #2408).
   *
   * `data-` stays a prefix: those types are open-ended by construction (`data-${string}`), so
   * there is no set to enumerate, and they are route-written and discrete rather than
   * streamed per token.
   */
  const isDurabilityBoundary = (chunk: UIMessageChunk): boolean =>
    TOOL_BOUNDARY_CHUNK_TYPES.has(chunk.type) ||
    chunk.type.startsWith('data-') ||
    chunk.type === 'start-step' ||
    chunk.type === 'finish-step' ||
    chunk.type === 'error' ||
    chunk.type === 'file' ||
    chunk.type === 'source-url' ||
    chunk.type === 'source-document';

  // The lifecycle watches its own channel to drive checkpoints. It does NOT feed the channel
  // — the pump does — which is the point: capture is independent of anything the lifecycle,
  // or any client, does. `finished` guards re-entry, since finish() closes the channel and
  // that closure calls straight back into this subscription's onEnd.
  channel.subscribe({
    fromSeq: 0,
    onFrame: (frame) => {
      // Defence in depth, and knowingly unreachable today: finish() sets this flag and THEN
      // closes the channel, and a closed channel refuses appends, so no frame can arrive after
      // the flag is set. Kept because the cost is a boolean and the failure it would prevent —
      // a checkpoint racing the terminal write with a post-finish snapshot — has enough history
      // in this file that a future reordering should fail closed. Mutation-tested: removing it
      // changes nothing, which is the point.
      if (finished) return;
      dirty = true;
      maybeCheckpoint(isDurabilityBoundary(frame.chunk));
    },
    onEnd: () => {
      // The channel ending is not by itself a reason to run the lifecycle's terminal write:
      // finish() is the only caller that knows whether this was an abort, and it closes the
      // channel itself. Nothing to do here.
    },
  });

  const getParts = (): Promise<UIMessagePart[]> => foldChunksToParts(channel.getFrames());

  return { finish, channel, getParts, preAborted: false };
};
