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
  /** Pending-buffer caps. Exceeding either closes the stream. See the constants below. */
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
  finish(aborted: boolean): void;
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

/** Pending-buffer caps for an ordinary readable subscriber. */
export const DEFAULT_MAX_PENDING_FRAMES = 20_000;
export const DEFAULT_MAX_PENDING_BYTES = 16 * 1024 * 1024;

/**
 * Caps for the HTTP response subscriber specifically.
 *
 * It is the one subscriber that cannot be told to resume — cutting it truncates a user's
 * visible reply — so it buys far more headroom before we give up. The code this replaces
 * had no bound here at all (the SDK's own queue grew unchecked), so this is a tightening,
 * just deliberately not an aggressive one.
 */
export const RESPONSE_MAX_PENDING_FRAMES = 200_000;
export const RESPONSE_MAX_PENDING_BYTES = 64 * 1024 * 1024;

/**
 * Rough byte cost of a frame, for the ring and pending budgets.
 *
 * Deliberately an estimate, not `JSON.stringify().length`: this runs on every frame of
 * every stream, and serializing a large tool output twice (once to measure, once to send)
 * is a real cost for a number whose only job is to decide when to stop buffering. Text
 * and reasoning deltas — the overwhelming majority — are measured almost exactly;
 * everything else takes a flat estimate, wrong only in the direction of undercounting a
 * big frame, which the frame-count cap independently covers.
 */
const estimateFrameBytes = (chunk: UIMessageChunk): number => {
  const delta = (chunk as { delta?: unknown }).delta;
  if (typeof delta === 'string') return delta.length + 64;
  const text = (chunk as { text?: unknown }).text;
  if (typeof text === 'string') return text.length + 64;
  return 512;
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

  const finish = (nextAborted: boolean): void => {
    if (finished) return;
    finished = true;
    aborted = nextAborted;
    for (const subscriber of [...subscribers]) {
      endSubscriber(subscriber, { reason: 'finished', aborted: nextAborted });
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
      endSubscriber(subscriber, { reason: 'finished', aborted });
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
        // Park until there is something to emit or the subscription has ended. `wake` is
        // single-slot, which is safe because the streams spec never runs two `pull`s
        // concurrently on one stream.
        while (pending.length === 0 && ended === null) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }

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
