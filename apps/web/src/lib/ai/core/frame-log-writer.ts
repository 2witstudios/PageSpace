import type { UIMessageChunk } from 'ai';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { estimateFrameBytes, type StreamChannel } from '@/lib/ai/core/stream-channel';
import { isDurabilityBoundary } from '@/lib/ai/core/durability-boundary';
import { appendFrameBatch, deleteFrames } from '@/lib/ai/core/frame-log';
import {
  shouldFlushFrames,
  FRAME_FLUSH_INTERVAL_MS,
} from '@/lib/ai/core/frame-log-batching';

/**
 * The durable frame log's WRITER: one per generation, subscribed to that generation's
 * channel, batching its frames into `ai_stream_frames`.
 *
 * It is a plain subscriber, exactly like the HTTP response and the SSE joiner, and that is
 * the point. It does not sit between the pump and the channel, so a slow or failing DB
 * cannot apply backpressure to — or stop — the generation. The channel's fan-out is
 * synchronous and this callback only buffers, so the cost on the pump's thread is a push.
 *
 * ERROR PATHS END THIS WRITER RATHER THAN LEAVING IT WEDGED. Every failure mode below
 * converges on `disable()`: the pre-write delete failing, a batch insert failing, the durable
 * budget running out, the write chain rejecting. A writer that kept a subscription and an
 * interval alive after it had stopped being able to write would leak both for the life of the
 * process, and — worse — a writer that kept BATCHING after a failed insert would punch a hole
 * in a log whose whole value is that it is a contiguous prefix.
 *
 * The ORDINARY end (`close()`, from the channel finishing or `lifecycle.finish()`) is
 * deliberately not the same thing: it stops intake but still writes the batch it just cut.
 * See the two flags below — collapsing them into one silently drops every stream's tail.
 */

/**
 * Per-stream ceiling on durable frames.
 *
 * Deliberately ABOVE the channel's in-memory ring (24 MB), so the durable log is never the
 * shorter of the two records — a recovery that read fewer frames than a live client saw
 * would make durability a downgrade. Bounded all the same: without a cap, one pathological
 * generation (a tool loop emitting megabyte outputs) could write unboundedly into a table
 * whose rows are only reclaimed when the stream ends.
 *
 * Past the cap the writer stops and the log holds a PREFIX. That is the same degradation the
 * ring already has, one binding constraint later, and it stays honest: a prefix is exactly
 * what a client that disconnected at that seq would have.
 */
const MAX_DURABLE_BYTES = 64 * 1024 * 1024;

export interface FrameLogWriter {
  /**
   * Flush what is pending, stop, and deregister. Idempotent; never rejects.
   *
   * The normal end of a writer's life — the channel finishing, or `lifecycle.finish()`.
   */
  close(): Promise<void>;
  /**
   * Stop and DISCARD what is pending, without writing it. Idempotent; never rejects.
   *
   * For the two cases where the pending frames are about to become garbage: retention has
   * confirmed the terminal message write, or a retry is about to delete this messageId's log
   * and record a new generation under it. Both then DELETE, and a `close()` there would race
   * its own final INSERT against that delete — re-creating exactly the spliced-generations
   * log the delete exists to prevent.
   *
   * Resolves only once any in-flight INSERT has settled, so a caller that deletes after
   * awaiting this cannot be undercut by a write still in the air.
   */
  abandon(): Promise<void>;
}

/**
 * Process-local index of live frame-log writers, keyed by assistant `messageId`.
 *
 * Same single-process caveat as `streamChannelRegistry`, and for the same reason: a writer
 * exists only on the instance running the generation. Callers that may run anywhere
 * (`releaseFramesForMessage`) treat a miss as "not ours" and go straight to the DELETE, which
 * is correct — if this process does not own the stream, no local write can race it.
 */
const writers = new Map<string, FrameLogWriter>();

export const startFrameLogWriter = ({
  messageId,
  conversationId,
  channel,
}: {
  messageId: string;
  conversationId: string;
  channel: StreamChannel;
}): FrameLogWriter => {
  // Taken BEFORE this writer registers itself, so a re-registered messageId can stop the
  // previous generation's writer rather than orphan it under an overwritten key.
  const superseded = writers.get(messageId);

  let pending: UIMessageChunk[] = [];
  let pendingBytes = 0;
  let oldestPendingAt = Date.now();
  /** Seq of the first pending frame — i.e. the `from_seq` the next batch will carry. */
  let nextFromSeq = 0;
  /** Estimated durable bytes written so far, against MAX_DURABLE_BYTES. */
  let writtenBytes = 0;
  /**
   * Intake is over: no more frames are buffered, and no more batches are cut.
   *
   * DELIBERATELY NOT THE SAME FLAG as `writesDisabled` below, and conflating the two is a
   * durability bug rather than a tidiness one. `close()` has to cut a final batch and then
   * stop taking frames — so if the queued write checked THIS flag, the close would cancel
   * the very flush it just scheduled and every stream would silently lose its tail.
   */
  let stopped = false;
  /**
   * Queued batches must not be written at all.
   *
   * Set only where writing would be WRONG rather than merely finished: the pre-write delete
   * failed (the log may still hold another generation), a batch insert failed (writing past
   * it would leave a hole), the durable budget ran out, or a caller abandoned the writer
   * because it is about to delete the log.
   */
  let writesDisabled = false;
  /** Serializes batch INSERTs so rows land in seq order and `abandon` has one thing to await. */
  let writeChain: Promise<void> = Promise.resolve();
  let unsubscribe: () => void = () => {};
  let interval: ReturnType<typeof setInterval> | null = null;

  /**
   * Prior frames for this messageId are deleted BEFORE the first insert, and every write
   * awaits this — a retry or takeover reuses the messageId, and a log holding both
   * generations replays them spliced together into a message that never existed.
   *
   * The previous writer is abandoned first (not closed): closing would flush its tail
   * straight into the window this delete is meant to clear.
   */
  const ready: Promise<boolean> = (async () => {
    try {
      if (superseded) await superseded.abandon();
    } catch {
      // `abandon` is documented never to reject; this is belt to that braces, and a
      // superseded writer failing to wind down must not stop the new one from recording.
    }
    return deleteFrames(messageId);
  })();

  const terminate = (): void => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };

  /**
   * Leave the registry — but only once this writer can no longer write.
   *
   * DELIBERATELY NOT PART OF `terminate()`, which runs while a final batch may still be
   * queued. `releaseFramesForMessage` resolves a writer through this map and awaits it before
   * DELETEing; a writer that deregistered early would be invisible to that lookup, its queued
   * INSERT would land after the DELETE, and the message would be left holding a partial log
   * that nothing reclaims until the retention backstop sweeps it a day later.
   *
   * Identity, not existence — the same rule the checkpoint's registry guard uses. A newer
   * writer may already have claimed this messageId (retry/takeover), and this one winding
   * down must not evict its successor's entry.
   */
  const deregister = (): void => {
    if (writers.get(messageId) === self) writers.delete(messageId);
  };

  /** Stop intake AND cancel anything still queued. See `writesDisabled`. */
  const disable = (): void => {
    writesDisabled = true;
    terminate();
  };

  /**
   * Take everything pending as one batch and queue its INSERT.
   *
   * The seq bookkeeping advances SYNCHRONOUSLY, before the write is queued: batches must
   * carry the seqs they were cut at, not the seqs that happen to be current when a queued
   * write finally runs. Getting that wrong under a slow DB would overlap two rows' ranges,
   * which the primary key would then reject — turning a latency spike into lost frames.
   */
  const flush = (): void => {
    if (stopped || pending.length === 0) return;

    const frames = pending;
    const fromSeq = nextFromSeq;
    const batchBytes = pendingBytes;

    pending = [];
    pendingBytes = 0;
    nextFromSeq += frames.length;

    writeChain = writeChain.then(async () => {
      if (writesDisabled) return;
      if (!(await ready)) {
        // The pre-write delete failed, so this messageId may still hold a previous
        // generation's rows. Writing now would either collide on the primary key or splice
        // two generations into one replay. Neither is worth a partial log.
        loggers.ai.warn('frame-log-writer: could not clear prior frames — durability disabled', {
          messageId,
        });
        disable();
        return;
      }

      const ok = await appendFrameBatch({ messageId, conversationId, fromSeq, frames });
      if (!ok) {
        // Stop at the FIRST failed batch. Continuing would leave a hole, and a log with a
        // hole is worse than a short one: the reader truncates at the gap anyway, so every
        // frame written after it is storage spent on content nothing will ever replay.
        disable();
        return;
      }

      writtenBytes += batchBytes;
      if (writtenBytes >= MAX_DURABLE_BYTES) {
        loggers.ai.warn('frame-log-writer: durable budget exhausted — log truncated to a prefix', {
          messageId,
          writtenBytes,
        });
        disable();
      }
    }).catch((error: unknown) => {
      // Nothing above is supposed to reject — `ready`, `appendFrameBatch` and `deleteFrames`
      // all resolve to a boolean instead. This exists because a rejected chain is the one
      // failure mode that would be SILENT and PERMANENT: every subsequent `.then` would be
      // skipped, so the writer would go on buffering frames it never wrote and `abandon`
      // would resolve on a rejection nobody handled. End the writer instead.
      loggers.ai.warn('frame-log-writer: write chain rejected — durability disabled', {
        messageId,
        error: error instanceof Error ? error.message : 'unknown',
      });
      disable();
    });
  };

  const maybeFlush = (isBoundary: boolean, now: number): void => {
    if (stopped) return;
    if (!shouldFlushFrames({
      pendingFrames: pending.length,
      pendingBytes,
      isBoundary,
      oldestPendingAt,
      now,
    })) return;
    flush();
  };

  const self: FrameLogWriter = {
    async close(): Promise<void> {
      if (!stopped) flush();
      terminate();
      // Settle whatever the flush queued, so a caller that awaits this knows the log is as
      // complete as it is ever going to be — and only then leave the registry.
      await writeChain.catch(() => {});
      deregister();
    },
    async abandon(): Promise<void> {
      // The semantic statement of what abandon means — and, on its own, redundant:
      // `disable()` below stops any batch this had already cut from being written, so
      // mutation-testing this line finds an equivalent mutant. Kept because "discard what is
      // pending" is what a caller asks for, and leaving the buffer populated would make the
      // writer's state disagree with its own contract for any future reader of it.
      pending = [];
      pendingBytes = 0;
      // `disable`, not `terminate`: a batch already queued must not land after the DELETE the
      // caller is about to issue, or the log is resurrected under a messageId that no longer
      // owns it.
      disable();
      await writeChain.catch(() => {});
      deregister();
    },
  };

  writers.set(messageId, self);

  unsubscribe = channel.subscribe({
    fromSeq: 0,
    onFrame: (frame) => {
      if (stopped) return;
      if (pending.length === 0) oldestPendingAt = Date.now();
      pending.push(frame.chunk);
      pendingBytes += estimateFrameBytes(frame.chunk);
      maybeFlush(isDurabilityBoundary(frame.chunk), Date.now());
    },
    onEnd: () => {
      // The generation is over — write the tail rather than leave it in memory to die with
      // the process. `close` is idempotent, so the lifecycle calling it too is harmless.
      void self.close();
    },
  });

  // Independent of the frame flow, for the same reason the checkpoint has its own interval: a
  // stream that goes quiet mid-turn (a long tool call after its last text delta) would
  // otherwise hold that delta in memory until the tool returned. Unref'd — a durability
  // flush must never hold the process open.
  interval = setInterval(() => {
    maybeFlush(false, Date.now());
  }, FRAME_FLUSH_INTERVAL_MS);
  interval.unref?.();

  return self;
};

/**
 * Release a message's durable frames — the retention half of the log's lifecycle.
 *
 * CALLED ONLY AFTER A TERMINAL MESSAGE WRITE IS CONFIRMED, and the ordering is the whole
 * contract. Frames exist to reconstruct a reply that no `messages` row holds yet; once one
 * does, they are storage. Deleting them a moment EARLIER — on `finish()`, say, which also
 * runs when the pump failed and nothing was persisted at all — would throw away the only
 * copy of a reply precisely in the case the log was built for.
 *
 * Stops this process's writer for the messageId first. Without that, the writer's final
 * flush can land after the DELETE and resurrect a partial log that nothing will ever
 * reclaim until the retention backstop sweeps it. `abandon` (not `close`) because everything
 * still pending is about to be deleted anyway.
 *
 * Never throws: it is called from persistence paths whose success must not depend on a
 * cleanup, and the retention backstop reclaims anything a failure here leaves behind.
 */
export const releaseFramesForMessage = async (messageId: string): Promise<void> => {
  try {
    await writers.get(messageId)?.abandon();
  } catch {
    // `abandon` never rejects; a failure to wind the writer down must not skip the delete.
  }
  await deleteFrames(messageId);
};
