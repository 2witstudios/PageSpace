import type { UIMessageChunk } from 'ai';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { estimateFrameBytes, type StreamChannel } from '@/lib/ai/core/stream-channel';
import { isDurabilityBoundary } from '@/lib/ai/core/durability-boundary';
import { appendFrameBatch, deleteFrames } from '@/lib/ai/core/frame-log';
import {
  shouldFlushFrames,
  FRAME_FLUSH_INTERVAL_MS,
} from '@/lib/ai/core/frame-log-batching';
import { isReapClaimStillHeld, type ReapClaim } from '@/lib/ai/core/stream-reap-claim';

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
  /**
   * Abandon this writer and DELETE its message's durable log — the retention release, aimed
   * at a writer INSTANCE rather than at a messageId.
   *
   * That distinction is the whole reason this exists alongside `releaseFramesForMessage`. A
   * lifecycle releases when its own terminal write is confirmed, and it identifies the log by
   * the only name it has: the messageId. But a messageId can be re-registered — the registry's
   * `open()`, the sessions INSERT's `onConflictDoUpdate`, and this module's own `superseded`
   * handling all exist for that case — and a by-name delete issued by a SUPERSEDED lifecycle
   * would wipe the log its successor is actively writing, destroying the durable record of a
   * live generation.
   *
   * So the delete is skipped when another writer has claimed this messageId. Identity, not
   * existence: no registered writer means this one finished normally and the log is still
   * rightfully its own, which must still delete.
   *
   * DEFENCE IN DEPTH, and knowingly so: `createStreamLifecycle` has a single call site and
   * `runAgentWithRetry` retries INSIDE one lifecycle, so today a messageId has exactly one
   * generation and `current` is never a different writer. It is guarded anyway because every
   * neighbouring mechanism guards it (the checkpoint compares channel identity for the same
   * reason and says the same thing), and because the failure it prevents — silently deleting a
   * running generation's only durable copy — is the worst outcome in this file.
   */
  release(): Promise<void>;
}

/**
 * Process-local index of live frame-log writers, keyed by assistant `messageId`.
 *
 * Same single-process caveat as `streamChannelRegistry`, and for the same reason: a writer
 * exists only on the instance running the generation.
 *
 * Membership is therefore evidence of LIVENESS, and `releaseFramesForMessage` reads it that
 * way: an entry means this process is still generating that message, so a by-name release —
 * which can only have come from something that believes the stream is over — is refused. A
 * miss means the generation is not ours (or is finished), and the delete proceeds.
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
   * awaits this — if a messageId were ever re-registered, a log holding both generations
   * would replay them spliced together into a message that never existed.
   *
   * DEFENSIVE, AND UNREACHABLE AS THE ROUTES STAND — said plainly so the next reader does not
   * have to reverse-engineer them to find that out. Both turn strategies mint a fresh
   * `serverAssistantMessageId` per request, and `startGenerationExclusive` guarantees
   * `createStreamLifecycle` runs exactly once per send, so no messageId is re-registered and
   * `superseded` is always undefined. What this costs is one extra DELETE, matching zero rows,
   * per generation — off the response's critical path, since the writer is a subscriber and
   * nothing awaits it. It is kept at that price because the failure it prevents is a message
   * that never existed being replayed to a user as if it had, and because the surrounding
   * mechanisms (the registry's `open()`, the sessions INSERT's `onConflictDoUpdate`) already
   * pay the same premium for the same reason.
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
   * DELIBERATELY NOT PART OF `terminate()`, which runs while a final batch may still be queued.
   * Registry membership is what `releaseFramesForMessage` reads as "this process is still
   * generating that message" and refuses on; a writer that deregistered while it could still
   * write would be invisible to that refusal, and the by-name DELETE would race its queued
   * INSERT.
   *
   * Identity, not existence — the same rule the checkpoint's registry guard uses. A newer
   * writer may already have claimed this messageId (retry/takeover), and this one winding
   * down must not evict its successor's entry.
   */
  const deregister = (): void => {
    if (writers.get(messageId) === self) writers.delete(messageId);
  };

  /**
   * The writer that has taken this messageId from us, or `null` if none has.
   *
   * An absent entry is NOT supersession — it is this writer having deregistered normally, and
   * its log is still rightfully its own to delete.
   */
  const supersededBy = (): FrameLogWriter | null => {
    const current = writers.get(messageId);
    if (current === undefined || current === self) return null;
    loggers.ai.warn('frame-log-writer: release skipped — this messageId was re-registered', {
      messageId,
    });
    return current;
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
    async release(): Promise<void> {
      // Wind down FIRST, then check ownership, then delete — and the order is the whole guard.
      //
      // Checking before the await instead would be a TOCTOU: `abandon()` waits out the
      // in-flight write chain, which is unbounded in time, and deregisters `self` on the way,
      // so a writer registering during that window is invisible to the earlier check AND will
      // not find `self` to wait for either. The stale DELETE would then land on the successor's
      // freshly inserted rows — the exact failure this guard exists to prevent, through the
      // guard (review finding — adversarial pass).
      //
      // Abandoning a writer that turns out to be superseded is harmless: it is already off the
      // registry and its successor never waited on it. So one check, in the only position that
      // holds, rather than a redundant fast-path check no test can distinguish.
      await self.abandon();
      if (supersededBy() !== null) return;
      await deleteFrames(messageId);
    },
  };

  writers.set(messageId, self);

  // ARMED BEFORE THE SUBSCRIPTION, and the order is load-bearing.
  //
  // `channel.subscribe` can call `onEnd` SYNCHRONOUSLY — for a channel that has already
  // finished, and for a `fromSeq` the ring no longer holds. That reaches `self.close()`, and
  // therefore `terminate()`, before `subscribe` has even returned. With the interval created
  // afterwards, `terminate()` would have found it still `null`, this line would then arm a
  // timer nobody owns, and every later `terminate()` would return early on `stopped` — a
  // 200ms tick retaining this closure for the life of the process.
  //
  // The window is real: `createStreamLifecycle` opens the channel, then awaits the sessions
  // INSERT and `consumePendingAbort` before starting this writer, and a takeover landing in
  // that gap finishes the channel. Creating the timer first makes `terminate()` able to clear
  // it in every ordering, rather than adding a guard that a future reordering could defeat
  // (review finding — coderabbitai, PR #2409).
  //
  // Independent of the frame flow, for the same reason the checkpoint has its own interval: a
  // stream that goes quiet mid-turn (a long tool call after its last text delta) would
  // otherwise hold that delta in memory until the tool returned. Unref'd — a durability
  // flush must never hold the process open. A tick with nothing pending is a no-op.
  interval = setInterval(() => {
    maybeFlush(false, Date.now());
  }, FRAME_FLUSH_INTERVAL_MS);
  interval.unref?.();

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

  return self;
};

/**
 * What entitles a by-name release to destroy this log. REQUIRED, and required for a reason.
 *
 * There are exactly two things that can license a delete-by-messageId, and neither of them is
 * "the caller believes the stream is over":
 *
 *   - `own-superseded-attempt` — the caller IS this messageId's generation path and is
 *     discarding an attempt it superseded itself (the pre-abort branch of
 *     `createStreamLifecycle`). Same process, same request, no other party involved.
 *   - `reap-claim` — the caller won an atomic reap claim on the session row, and the claim is
 *     still verifiable at delete time. See `stream-reap-claim.ts`.
 *
 * Making it a required parameter rather than an optional one is the whole design. This function
 * used to take a messageId alone, so every caller was implicitly asserting a right it had no
 * way to demonstrate — and a future caller could acquire that right by writing one line. The
 * type is now the thing that stops it.
 */
export type FrameReleaseFence =
  | { kind: 'own-superseded-attempt' }
  | { kind: 'reap-claim'; claim: ReapClaim };

/**
 * Release a message's durable frames BY NAME — for a caller that holds no writer.
 *
 * The crash-recovery path (`materializeInterruptedStream`) and the pre-abort cleanup, both of
 * which act on a messageId whose generation belongs to a process that is gone, or has not
 * started. A lifecycle releasing its OWN generation uses `writer.release()` instead, which
 * cannot delete a successor's log.
 *
 * IT REFUSES TO TOUCH A LIVE GENERATION, and that refusal is the point. A registered writer
 * means THIS process is still generating that message — so whatever concluded the stream was
 * finished is either wrong or racing, and acting on it would be destructive twice over:
 * `abandon()` sets `writesDisabled`, which is terminal and never re-armed, so durability for
 * that generation would be off for the rest of its life; and the DELETE would drop the frames
 * it had written so far. The generation would keep streaming to the user with no durable
 * record at all — precisely the state this table exists to remove, entered silently.
 *
 * The trigger is not hypothetical. Liveness is heartbeat-based and the heartbeat write
 * swallows its own failures, so a Postgres blip longer than STREAM_HEARTBEAT_STALE_MS leaves
 * every in-flight row looking stale; when the database comes back, the next `/active-streams`
 * poll judges them all provably dead and reaps them — on the very instance that is still
 * generating them.
 *
 * ── THE `writers` CHECK IS NOT ENOUGH AT N>1, AND THAT IS WHY THE FENCE EXISTS ───────────────
 *
 * `writers` is process-local. On the instance that is generating, it holds an entry and the
 * refusal below fires. On EVERY OTHER instance it is empty — so the exact same reap, landing on
 * a peer, sailed straight through this guard and deleted a live generation's log. The guard was
 * never wrong; it was just answering a question ("is it mine?") that stopped being the same as
 * the question that matters ("is it anyone's?") the moment there was more than one machine.
 *
 * So the local check stays — it is the cheapest possible answer and it is authoritative when it
 * fires — and a `reap-claim` fence answers the cross-instance half by re-verifying, against
 * Postgres, that the claim this caller won is still held. Both must pass.
 *
 * A refused delete logs `warn` rather than staying silent: in production a nonzero count of
 * either refusal is a REAL near-miss on live content, and the only way anyone learns the N>1
 * reap race is firing is if the near-misses are visible.
 *
 * Never throws: it is called from persistence paths whose success must not depend on a
 * cleanup, and the retention backstop reclaims anything a failure here leaves behind.
 */
export const releaseFramesForMessage = async (
  messageId: string,
  fence: FrameReleaseFence,
): Promise<void> => {
  if (writers.has(messageId)) {
    loggers.ai.warn('frame-log: release by name refused — this process is still generating that message', {
      messageId,
      fence: fence.kind,
    });
    return;
  }

  // The claim has to be a claim on THIS message. Without this the fence is checkable but not
  // binding: `isReapClaimStillHeld` verifies the claim's OWN messageId, so a caller passing a
  // valid claim for some other row would pass the check and then delete these frames — a live
  // log destroyed by a fence that reported itself satisfied. The type makes the fence
  // unforgettable; this makes it match the thing it is fencing.
  if (fence.kind === 'reap-claim' && fence.claim.messageId !== messageId) {
    loggers.ai.warn('frame-log: release by name refused — the claim names a different message', {
      messageId,
      claimedMessageId: fence.claim.messageId,
    });
    return;
  }

  if (fence.kind === 'reap-claim' && !(await isReapClaimStillHeld(fence.claim))) {
    loggers.ai.warn('frame-log: release by name refused — the reap claim no longer holds', {
      messageId,
      claimedAt: fence.claim.claimedAt.toISOString(),
    });
    return;
  }

  await deleteFrames(messageId);
};
