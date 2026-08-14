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
import { createPartsFolder } from '@/lib/ai/streams/foldChunksToParts';
import { consumePendingAbort } from '@/lib/ai/core/pending-abort-intents';
import { decideCheckpoint, CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS } from '@/lib/ai/core/checkpoint-scheduler';
import { isDurabilityBoundary } from '@/lib/ai/core/durability-boundary';
import { startFrameLogWriter, releaseFramesForMessage } from '@/lib/ai/core/frame-log-writer';

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

    // A pre-aborted attempt records nothing, so no frame-log writer is started for it — but a
    // PREVIOUS attempt on this messageId may have left durable frames, and this row's `parts`
    // were just reset for exactly that reason. Clearing them here keeps the two records
    // agreeing; leaving them would let a recovery materialize the superseded generation's
    // reply under a messageId whose row already says 'aborted'. Fire-and-forget, like the rest
    // of this branch's cleanup: it never rejects, and the retention backstop covers a failure.
    void releaseFramesForMessage(messageId);

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

  /**
   * The durable frame log for this generation.
   *
   * Another plain subscriber on the same channel — it does not sit between the pump and the
   * channel, so a slow or failing Postgres cannot apply backpressure to the generation. This
   * is the record that survives the process: `parts` below is a folded snapshot on a row that
   * is cleared the moment the stream ends, whereas these are the frames themselves.
   *
   * Started AFTER the pending-abort check, so a stream that never generates never writes. Its
   * first act is to delete any frames left by a previous attempt on this messageId, for the
   * same reason the INSERT above resets `parts`: a retry or takeover reuses the id, and a log
   * holding both generations replays them spliced into a message that never existed.
   */
  const frameLog = startFrameLogWriter({ messageId, conversationId, channel });

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
   * The stream's running reduction — fed one frame at a time, for the life of the generation.
   *
   * THIS IS WHAT MAKES EVICTION STOP BEING TRUNCATION. The checkpoint used to fold
   * `channel.getFrames()`, i.e. whatever the memory ring still held, so a reply long enough to
   * evict its oldest frames wrote a snapshot that had silently lost its beginning. The
   * lifecycle already subscribes to every frame exactly once, in order, before any eviction
   * can reach it — so folding THERE keeps the whole message regardless of what the ring drops.
   * The ring's caps go back to being what they were meant to be: a bound on replay latency for
   * late joiners, not a bound on what a reply may contain.
   *
   * It is also strictly cheaper. Re-folding the ring on every checkpoint was O(frames) per
   * write and O(frames²) across a turn; this is O(frames) for the whole turn, with a
   * per-checkpoint cost of cloning tens of parts.
   *
   * `push` is async (`tool-input-delta` reconstructs partial JSON), and frames arrive from a
   * SYNCHRONOUS fan-out, so they are chained rather than awaited at the call site — the chain
   * is what preserves order. `foldedFrames` counts what the folder has actually absorbed, and
   * is deliberately not `channel.nextSeq`: a frame appended after a reader awaited the chain
   * would be counted by the channel but not yet reflected in `parts`, and a `rawPartsCount`
   * that runs ahead of the snapshot it describes makes an old client over-skip on rejoin —
   * a silent, permanent gap in the reply it renders.
   */
  const folder = createPartsFolder();
  let foldChain: Promise<void> = Promise.resolve();
  let foldedFrames = 0;
  const foldFrame = (chunk: UIMessageChunk): void => {
    foldChain = foldChain
      .then(async () => {
        await folder.push(chunk);
        foldedFrames += 1;
      })
      .catch((error: unknown) => {
        // A rejected chain would skip every later push, so the fold would freeze at this frame
        // while the checkpoint went on writing that frozen snapshot as if it were current.
        // Absorb it: the frame is lost from the reduction, the rest of the stream is not.
        loggers.ai.warn('stream-lifecycle: fold failed for a frame', {
          messageId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      });
  };

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
   * THE KNOWN TRUNCATION IS CLOSED. This used to fold `channel.getFrames()` — what the memory
   * ring still held — so a reply long enough to evict its oldest frames wrote a snapshot that
   * had silently lost its beginning. It now reads the running fold above, which absorbed every
   * frame before eviction could reach it, so what gets written is the whole message however
   * long it ran. (The durable frame log is the other half of the same answer: it holds the
   * frames themselves, so a crash recovery does not depend on this column at all.)
   *
   * `rawPartsCount` is still written (as the folded frame count) because the column is NOT NULL
   * and older clients still read it; it is dropped with the parts column in the contract leaf.
   */
  const persistCheckpoint = (): Promise<void> => {
    const attempt = (async () => {
      try {
        // Awaited first, then both values read in the SAME synchronous step, so the snapshot
        // and the count it advertises can never describe different sets of frames.
        await foldChain;
        const shaped = folder.parts;
        const frameCount = foldedFrames;
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
    persistCheckpoint();
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

    // Flush the frame log's tail rather than let it die with the process. NOT a delete: the
    // frames are released only once a terminal message write is CONFIRMED (see
    // `releaseFramesForMessage`), and finish() runs on paths where no such write happened at
    // all — the pump failing is the clearest one, and it is precisely the case the durable log
    // exists for. Closing the channel below ends this writer's subscription too, so this is
    // belt to that braces; both are idempotent.
    void frameLog.close();

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
      foldFrame(frame.chunk);
      dirty = true;
      maybeCheckpoint(isDurabilityBoundary(frame.chunk));
    },
    onEnd: () => {
      // The channel ending is not by itself a reason to run the lifecycle's terminal write:
      // finish() is the only caller that knows whether this was an abort, and it closes the
      // channel itself. Nothing to do here.
    },
  });

  const getParts = async (): Promise<UIMessagePart[]> => {
    await foldChain;
    return folder.parts;
  };

  return { finish, channel, getParts, preAborted: false };
};
