import type { UIMessageChunk } from 'ai';

/**
 * A live, seq-addressed, multi-subscriber view of ONE generation's raw
 * `UIMessageChunk` frames.
 *
 * THE INVERSION THIS EXISTS FOR.
 *
 * The routes used to hand `createUIMessageStream`'s output straight to
 * `createUIMessageStreamResponse` and re-derive a second, lossy copy on the side via
 * `onChunk` + `chunkToPart`. That made the HTTP response body the privileged channel:
 * whoever held it saw the real stream, and everything else — a rejoining tab, a second
 * browser, the crash materializer, the durable save — saw a four-case projection.
 *
 * Now the pump owns the SDK stream and the response is subscriber #0. Concretely:
 *
 *   const channel = openStreamChannel({ messageId });
 *   const sdkStream = createUIMessageStream({ ... });
 *   void pumpSdkStreamToChannel(sdkStream, channel);          // sole reader
 *   return createUIMessageStreamResponse({
 *     stream: channel.subscribeReadable({ fromSeq: 0 }),      // NO request.signal — see below
 *   });
 *
 * Two alternatives were considered and are wrong here, both for the same reason —
 * they couple capture to whether a client is reading:
 *
 *   - `stream.tee()` enqueues into both branches whenever EITHER pulls, so the branch
 *     nobody reads grows without bound. "Nobody is reading" is the case this whole
 *     effort is built for, so that is the common case, not the edge.
 *   - A pass-through `TransformStream` only runs `transform()` when downstream pulls.
 *     A client disconnect cancels the response body, the cancel propagates upstream, and
 *     capture STOPS while `execute` keeps running — silently regressing the disconnect
 *     immunity that is the one property this system already had.
 *
 * With the pump as sole reader, a subscriber disconnecting cancels one `ReadableStream`
 * and the pump never notices.
 *
 * THE INVARIANT, stated once so it is not eroded later: **frames are never dropped
 * silently.** A consumer that cannot keep up is dropped and told the exact seq to resume
 * from; a frame evicted from the memory ring leaves `firstAvailableSeq` behind so a late
 * joiner is told it cannot be served from here rather than being handed a
 * plausible-looking gap.
 *
 * WHERE BACKPRESSURE LIVES. `subscribe` is a synchronous fan-out: it invokes the callback
 * inline, so at that layer there is no queue and nothing to bound. Backlog only exists in
 * whatever the callback feeds, so the caps live there — in `subscribeReadable`'s pending
 * buffer, and in the SSE route's own. (An earlier draft put monotonic counters in
 * `subscribe` itself; because nothing could ever decrement them, every subscriber would
 * have been cut off partway through a long reply. Noted so it is not reintroduced.)
 */

export interface ChannelFrame {
  seq: number;
  chunk: UIMessageChunk;
}

/**
 * Why a subscription ended.
 *
 * - `finished`  — the generation ended. `aborted` says whether it was stopped.
 * - `overflow`  — the requested seq is no longer in the ring. `resumeFromSeq` is the
 *                 oldest seq that IS available, so the caller can serve the gap from the
 *                 durable log or tell the client where to restart.
 * - `closed`    — the subscriber's own consumer went away, or it threw.
 */
export type ChannelEndReason = 'finished' | 'overflow' | 'closed';

export interface ChannelEnd {
  reason: ChannelEndReason;
  aborted: boolean;
  /** Set when `reason === 'overflow'`. */
  resumeFromSeq?: number;
  /**
   * What this subscriber received is NOT the whole message, and no resume point can fix it.
   *
   * Distinct from `overflow`, which names a seq the reader can restart from. This says the
   * SOURCE cannot serve the rest at all — the durable log was released while a follower was
   * reading it, or it holds a hole. There is nothing to resume from; the only correct answer is
   * to reload the durably-persisted message.
   *
   * Never set by a locally-owned channel, whose ring is the live record by construction. It
   * exists for the remote follower (`remote-frame-follower.ts`), and it rides `ChannelEnd` —
   * rather than being a special case in the SSE route — precisely so the route stays one code
   * path for both sources.
   */
  truncated?: boolean;
}

export interface SubscribeOptions {
  /** First seq wanted. 0 replays everything the ring still holds. */
  fromSeq: number;
  /** Called inline, in seq order. Must not block. */
  onFrame: (frame: ChannelFrame) => void;
  onEnd: (end: ChannelEnd) => void;
}

export interface SubscribeReadableOptions {
  fromSeq: number;
  /**
   * Optional early detach. **The generation routes must NOT pass `request.signal` here.**
   *
   * Two reasons, and the first is the one that matters. `disconnect-immunity.test.ts` is a
   * source-level tripwire that forbids any read of `request.signal` in
   * `app/api/ai/chat/route.ts` and `app/api/ai/global/[id]/messages/route.ts`, because
   * that is a one-line change that silently reverts the system to client-owned streams and
   * breaks no test. It is a blunt line-level check and it cannot tell "wired into
   * streamText" (catastrophic) from "wired into a subscriber's detach" (harmless), so the
   * routes simply must not name it. Do not amend the allowlist — the tripwire's own
   * docblock asks you not to.
   *
   * Second: it is redundant there anyway. When an HTTP client hangs up, the response
   * `ReadableStream` is cancelled, which runs `cancel()` below and detaches the
   * subscriber. That is already the disconnect path, and it is covered by the
   * "response reader cancelling mid-stream does not stop capture" test.
   *
   * A pure SUBSCRIBER route (`stream-join`) is the mirror image and should pass it — an
   * SSE reader going away has to detach or the channel leaks a subscriber per dead tab.
   * `disconnect-immunity.test.ts` asserts that route DOES read the signal, so nobody
   * applies the rule above to the wrong side.
   */
  signal?: AbortSignal;
  /**
   * Pending-buffer caps. Exceeding either closes this stream (the channel keeps recording).
   *
   * The HTTP response subscriber should pass values well above the defaults: it is the only
   * subscriber with no resume path, so being cut truncates a user's visible reply instead of
   * causing a reconnect. Every other subscriber is cheap to drop and re-attach from a seq.
   */
  maxPendingFrames?: number;
  maxPendingBytes?: number;
}

export interface StreamChannelOptions {
  messageId: string;
  /** Ring caps. Past these the OLDEST frames are evicted and `firstAvailableSeq` rises. */
  maxMemoryFrames?: number;
  maxMemoryBytes?: number;
}

export interface StreamChannel {
  readonly messageId: string;
  /** Seq the next appended frame will get; also the count of frames ever appended. */
  readonly nextSeq: number;
  /** Oldest seq still in memory. Rises as the ring evicts. */
  readonly firstAvailableSeq: number;
  readonly finished: boolean;
  readonly aborted: boolean;
  readonly subscriberCount: number;
  append(chunk: UIMessageChunk): void;
  /**
   * End the channel. `truncated` marks an end where what was delivered is provably incomplete
   * and unresumable — see `ChannelEnd.truncated`. A generation never passes it; a follower
   * reading a released or holed durable log does.
   */
  finish(aborted: boolean, options?: { truncated?: boolean }): void;
  /** Frames still in memory from `fromSeq` onward. For the checkpoint / terminal fold. */
  getFrames(fromSeq?: number): UIMessageChunk[];
  subscribe(options: SubscribeOptions): () => void;
  subscribeReadable(options: SubscribeReadableOptions): ReadableStream<UIMessageChunk>;
}

/**
 * Ring caps. Once the durable frame log lands it is the authority and memory is a latency
 * optimization, so eviction here is not data loss — it means a joiner asking for an
 * evicted seq must be served from the log rather than from here. Until then, eviction is
 * bounded by these being generous enough to hold any realistic single reply.
 */
const DEFAULT_MAX_MEMORY_FRAMES = 50_000;
const DEFAULT_MAX_MEMORY_BYTES = 24 * 1024 * 1024;

/**
 * Pending-buffer caps for a readable subscriber, when it names none of its own.
 *
 * Not exported: nothing outside this module needs the numbers, and shipping exported
 * constants ahead of their consumer is what the dead-code gate exists to catch. The one
 * caller that will want its own values is the HTTP response — it is the only subscriber
 * that cannot be told to resume, so cutting it truncates a user's visible reply rather
 * than causing a recoverable reconnect. It passes generous caps explicitly when the routes
 * are wired; the rationale lives on `SubscribeReadableOptions.maxPendingFrames` so it does
 * not have to survive as an unused symbol in the meantime.
 */
const DEFAULT_MAX_PENDING_FRAMES = 20_000;
const DEFAULT_MAX_PENDING_BYTES = 16 * 1024 * 1024;

/**
 * Byte cost of a frame, for the ring and pending budgets.
 *
 * Text and reasoning deltas are the overwhelming majority of frames and carry their payload
 * in a single string, so they are measured directly and cheaply.
 *
 * Everything else is MEASURED, not estimated, and that matters. A flat estimate here was a
 * real hole: tool-output frames carry arbitrarily large payloads and have no `delta`/`text`
 * string, so a 5 MB tool result counted as a few hundred bytes. The byte budget then bounded
 * nothing, and the only surviving limit was the frame COUNT — i.e. the true worst case was
 * `maxMemoryFrames × actual frame size`, not `maxMemoryBytes`. The frame-count cap does not
 * "independently cover" that, whatever an earlier version of this comment claimed: tens of
 * thousands of multi-megabyte frames is not a bound anyone wants.
 *
 * The serialization cost is affordable precisely because these frames are rare — a handful of
 * tool boundaries per turn against thousands of text deltas — and it buys a budget that means
 * what it says. `JSON.stringify` can throw on a circular payload; an unmeasurable frame is
 * charged a deliberately large amount so it counts AGAINST the budget rather than slipping
 * under it.
 *
 * EXPORTED for the durable frame log's batch budget (`frame-log-writer.ts`), which needs the
 * same hot-path-cheap estimate for the same reason and must not grow a second one that
 * charges tool outputs differently. It is an ESTIMATE and only ever gates a budget — where
 * the frame log records a size it means to be true (`ai_stream_frames.byte_size`), it
 * serializes the batch once and measures it exactly instead.
 */
const UNMEASURABLE_FRAME_BYTES = 1024 * 1024;

export const estimateFrameBytes = (chunk: UIMessageChunk): number => {
  const delta = (chunk as { delta?: unknown }).delta;
  if (typeof delta === 'string') return delta.length + 64;
  const text = (chunk as { text?: unknown }).text;
  if (typeof text === 'string') return text.length + 64;
  try {
    return JSON.stringify(chunk).length + 64;
  } catch {
    return UNMEASURABLE_FRAME_BYTES;
  }
};

interface Subscriber {
  onFrame: (frame: ChannelFrame) => void;
  onEnd: (end: ChannelEnd) => void;
  ended: boolean;
}

export const openStreamChannel = (options: StreamChannelOptions): StreamChannel => {
  const {
    messageId,
    maxMemoryFrames = DEFAULT_MAX_MEMORY_FRAMES,
    maxMemoryBytes = DEFAULT_MAX_MEMORY_BYTES,
  } = options;

  const ring: ChannelFrame[] = [];
  let ringBytes = 0;
  let nextSeq = 0;
  let firstAvailableSeq = 0;
  let finished = false;
  let aborted = false;
  let truncated = false;

  const subscribers = new Set<Subscriber>();

  const endSubscriber = (subscriber: Subscriber, end: ChannelEnd): void => {
    if (subscriber.ended) return;
    subscriber.ended = true;
    subscribers.delete(subscriber);
    try {
      subscriber.onEnd(end);
    } catch {
      // A subscriber throwing on its own teardown must not take down the fan-out.
    }
  };

  const evictIfNeeded = (): void => {
    while (ring.length > 0 && (ring.length > maxMemoryFrames || ringBytes > maxMemoryBytes)) {
      const evicted = ring.shift();
      if (!evicted) break;
      ringBytes -= estimateFrameBytes(evicted.chunk);
      firstAvailableSeq = evicted.seq + 1;
    }
  };

  const append = (chunk: UIMessageChunk): void => {
    // A frame appended after finish() would reach a late joiner replaying the ring but
    // not anyone who already left, so the two would disagree about what the stream
    // contained. Refuse instead.
    if (finished) return;

    const frame: ChannelFrame = { seq: nextSeq, chunk };
    nextSeq += 1;
    ring.push(frame);
    ringBytes += estimateFrameBytes(chunk);
    evictIfNeeded();

    // Snapshot: a subscriber's onFrame may unsubscribe itself (or another).
    for (const subscriber of [...subscribers]) {
      if (subscriber.ended) continue;
      try {
        subscriber.onFrame(frame);
      } catch {
        // One bad subscriber must never break fan-out to the others — the same rule the
        // multicast registry this replaces held.
        endSubscriber(subscriber, { reason: 'closed', aborted: false });
      }
    }
  };

  const finish = (nextAborted: boolean, options?: { truncated?: boolean }): void => {
    if (finished) return;
    finished = true;
    aborted = nextAborted;
    // Recorded, so a subscriber that joins AFTER the end is told the same thing as one that was
    // already attached. A late joiner replaying a truncated log and being handed a clean `done`
    // would render the short reply as if it were the whole one.
    truncated = options?.truncated === true;
    for (const subscriber of [...subscribers]) {
      endSubscriber(subscriber, { reason: 'finished', aborted: nextAborted, truncated });
    }
  };

  const getFrames = (fromSeq = 0): UIMessageChunk[] =>
    ring.filter((frame) => frame.seq >= fromSeq).map((frame) => frame.chunk);

  const subscribe = (subscribeOptions: SubscribeOptions): (() => void) => {
    // Requested a seq the ring no longer holds. Do NOT quietly start from the oldest
    // surviving frame: that hands the subscriber a gap it cannot see, which is the class
    // of silent corruption the skipReplayCount arithmetic used to produce. Say so, and
    // let the caller decide (the SSE joiner answers 409 with a resume point).
    if (subscribeOptions.fromSeq < firstAvailableSeq) {
      subscribeOptions.onEnd({
        reason: 'overflow',
        aborted: false,
        resumeFromSeq: firstAvailableSeq,
      });
      return () => {};
    }

    const subscriber: Subscriber = {
      onFrame: subscribeOptions.onFrame,
      onEnd: subscribeOptions.onEnd,
      ended: false,
    };
    subscribers.add(subscriber);

    // Replay what the ring already holds, then live frames arrive via `append`. Both go
    // through the same callback in seq order, so a joiner cannot tell them apart.
    for (const frame of ring) {
      if (subscriber.ended) break;
      if (frame.seq < subscribeOptions.fromSeq) continue;
      try {
        subscriber.onFrame(frame);
      } catch {
        endSubscriber(subscriber, { reason: 'closed', aborted: false });
      }
    }

    // A stream that already ended still replays in full above, then ends — so a client
    // that joins a beat late gets the whole reply rather than an empty stream.
    if (!subscriber.ended && finished) {
      endSubscriber(subscriber, { reason: 'finished', aborted, truncated });
    }

    return () => {
      if (subscriber.ended) return;
      subscriber.ended = true;
      subscribers.delete(subscriber);
    };
  };

  const subscribeReadable = (
    readableOptions: SubscribeReadableOptions,
  ): ReadableStream<UIMessageChunk> => {
    const maxPendingFrames = readableOptions.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES;
    const maxPendingBytes = readableOptions.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;

    // Pull-driven, not enqueue-on-arrival. This is what makes the cap meaningful: the
    // buffer drains exactly as the consumer reads, so "pending" measures real backlog
    // instead of counting every frame the stream ever carried.
    const pending: UIMessageChunk[] = [];
    let pendingBytes = 0;
    let ended: ChannelEnd | null = null;
    /**
     * The consumer cancelled this stream. Distinct from `ended`, which records why the
     * SUBSCRIPTION ended — a cancel is the other direction, and the difference matters to
     * `pull`: on an `ended` wake it still has to drain and close the controller, whereas on a
     * cancel the controller is no longer closeable and there is nobody left to drain for.
     */
    let cancelled = false;
    let wake: (() => void) | null = null;
    let unsubscribe: () => void = () => {};
    let onAbort: (() => void) | null = null;

    const signalReady = (): void => {
      const resume = wake;
      wake = null;
      resume?.();
    };

    const detach = (): void => {
      unsubscribe();
      if (readableOptions.signal && onAbort) {
        readableOptions.signal.removeEventListener('abort', onAbort);
        onAbort = null;
      }
    };

    return new ReadableStream<UIMessageChunk>({
      start() {
        unsubscribe = subscribe({
          fromSeq: readableOptions.fromSeq,
          onFrame: (frame) => {
            const bytes = estimateFrameBytes(frame.chunk);
            if (pending.length + 1 > maxPendingFrames || pendingBytes + bytes > maxPendingBytes) {
              // This consumer is not keeping up. Stop feeding it and end the stream at a
              // known point rather than growing without bound.
              ended = { reason: 'overflow', aborted: false, resumeFromSeq: frame.seq };
              detach();
              signalReady();
              return;
            }
            pending.push(frame.chunk);
            pendingBytes += bytes;
            signalReady();
          },
          onEnd: (end) => {
            ended = end;
            signalReady();
          },
        });

        if (readableOptions.signal) {
          onAbort = () => {
            ended = ended ?? { reason: 'closed', aborted: false };
            detach();
            signalReady();
          };
          if (readableOptions.signal.aborted) onAbort();
          else readableOptions.signal.addEventListener('abort', onAbort, { once: true });
        }
      },
      async pull(controller) {
        // Park until there is something to emit, the subscription has ended, or the consumer
        // cancelled. `wake` is single-slot, which is safe because the streams spec never runs
        // two `pull`s concurrently on one stream.
        //
        // `cancelled` is in the condition, not merely checked after: `cancel()` clears
        // `pending` and wakes this loop, so without it the loop finds nothing to emit and no
        // end reason and parks again on a FRESH promise — and no later `signalReady` can
        // arrive, because the subscription is already detached. The stream is closed either
        // way, so nothing observable breaks; the leak is that the never-settling promise keeps
        // this closure and its buffers reachable for the life of the process (review finding —
        // coderabbitai, PR #2408).
        while (pending.length === 0 && ended === null && !cancelled) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }

        // Return WITHOUT touching the controller. A cancelled stream is no longer in a
        // closeable state, so calling `close()` here would throw a TypeError into the pull
        // promise — swapping a silent leak for a spurious rejection.
        if (cancelled) return;

        const chunk = pending.shift();
        if (chunk !== undefined) {
          pendingBytes -= estimateFrameBytes(chunk);
          controller.enqueue(chunk);
          return;
        }

        // Drained, and the subscription is over. Every end reason closes cleanly rather
        // than erroring: an abort or an overflow is not an HTTP-level failure, and the
        // durable channel — not this body — is the authority for what the message
        // contained. Erroring would strip the client of the partial reply it already has.
        detach();
        controller.close();
      },
      cancel() {
        // The consumer is gone (an HTTP client disconnecting, say). Drop the subscription
        // only — the generation is server-owned and keeps running.
        //
        // Setting `cancelled` BEFORE waking is what releases a parked `pull` — see the loop
        // condition there for the leak this closes. Deliberately a separate flag rather than
        // an `ended` reason: `ended` is the subscription's own terminal state and `pull`
        // still drains and closes the controller on it, which is exactly what must not
        // happen for a stream whose consumer has already gone.
        cancelled = true;
        detach();
        pending.length = 0;
        pendingBytes = 0;
        signalReady();
      },
    });
  };

  return {
    messageId,
    get nextSeq() {
      return nextSeq;
    },
    get firstAvailableSeq() {
      return firstAvailableSeq;
    },
    get finished() {
      return finished;
    },
    get aborted() {
      return aborted;
    },
    get subscriberCount() {
      return subscribers.size;
    },
    append,
    finish,
    getFrames,
    subscribe,
    subscribeReadable,
  };
};
