import { describe, it, expect } from 'vitest';
import type { UIMessageChunk } from 'ai';
import {
  openStreamChannel,
  type ChannelEnd,
  type ChannelFrame,
} from '@/lib/ai/core/stream-channel';
import { pumpSdkStreamToChannel } from '@/lib/ai/core/pump-sdk-stream';
import { StreamChannelRegistry } from '@/lib/ai/core/stream-channel-registry';

const chunk = (value: unknown): UIMessageChunk => value as UIMessageChunk;
const textDelta = (delta: string): UIMessageChunk =>
  chunk({ type: 'text-delta', id: 't1', delta });

const collect = (
  channel: ReturnType<typeof openStreamChannel>,
  fromSeq = 0,
): { frames: ChannelFrame[]; end: ChannelEnd | null; unsubscribe: () => void } => {
  const frames: ChannelFrame[] = [];
  let end: ChannelEnd | null = null;
  const unsubscribe = channel.subscribe({
    fromSeq,
    onFrame: (frame) => frames.push(frame),
    onEnd: (value) => {
      end = value;
    },
  });
  return {
    frames,
    get end() {
      return end;
    },
    unsubscribe,
  } as { frames: ChannelFrame[]; end: ChannelEnd | null; unsubscribe: () => void };
};

const readAll = async (stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> => {
  const out: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) out.push(value);
  }
  return out;
};

const streamOf = (frames: UIMessageChunk[]): ReadableStream<UIMessageChunk> =>
  new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame);
      controller.close();
    },
  });

describe('stream-channel — seq and fan-out', () => {
  it('given appended frames, should number them from zero in order', () => {
    const channel = openStreamChannel({ messageId: 'm1' });
    channel.append(textDelta('a'));
    channel.append(textDelta('b'));

    expect(channel.nextSeq).toBe(2);
    expect(channel.firstAvailableSeq).toBe(0);
    expect(channel.getFrames()).toEqual([textDelta('a'), textDelta('b')]);
  });

  it('given a subscriber joining late, should replay the ring then continue live', () => {
    const channel = openStreamChannel({ messageId: 'm1' });
    channel.append(textDelta('one'));
    channel.append(textDelta('two'));

    const sub = collect(channel, 0);
    expect(sub.frames.map((f) => f.seq)).toEqual([0, 1]);

    channel.append(textDelta('three'));
    expect(sub.frames.map((f) => f.seq)).toEqual([0, 1, 2]);
  });

  it('given a fromSeq cursor, should deliver only frames at or after it', () => {
    const channel = openStreamChannel({ messageId: 'm1' });
    channel.append(textDelta('a'));
    channel.append(textDelta('b'));
    channel.append(textDelta('c'));

    expect(collect(channel, 2).frames.map((f) => f.seq)).toEqual([2]);
  });

  it('given many subscribers, should deliver identical frames to each', () => {
    const channel = openStreamChannel({ messageId: 'm1' });
    const first = collect(channel);
    const second = collect(channel);

    channel.append(textDelta('x'));
    channel.append(textDelta('y'));

    expect(first.frames).toEqual(second.frames);
    expect(channel.subscriberCount).toBe(2);
  });

  it('given a subscriber whose callback throws, should keep delivering to the others', () => {
    const channel = openStreamChannel({ messageId: 'm1' });
    const healthy = collect(channel);
    channel.subscribe({
      fromSeq: 0,
      onFrame: () => {
        throw new Error('bad subscriber');
      },
      onEnd: () => {},
    });

    channel.append(textDelta('a'));
    channel.append(textDelta('b'));

    expect(healthy.frames).toHaveLength(2);
    expect(channel.subscriberCount).toBe(1);
  });

  it('given a stream that already finished, should still replay in full then end', () => {
    // A client that joins a beat after completion must get the whole reply, not an empty
    // stream — this is the ordinary "socket event arrives just after the run ended" race.
    const channel = openStreamChannel({ messageId: 'm1' });
    channel.append(textDelta('all'));
    channel.append(textDelta(' of it'));
    channel.finish(false);

    const sub = collect(channel);
    expect(sub.frames).toHaveLength(2);
    expect(sub.end).toEqual({ reason: 'finished', aborted: false });
  });

  it('given finish(true), should report aborted to subscribers', () => {
    const channel = openStreamChannel({ messageId: 'm1' });
    const sub = collect(channel);
    channel.finish(true);

    expect(sub.end).toEqual({ reason: 'finished', aborted: true });
  });

  it('given an append after finish, should refuse it', () => {
    // Otherwise a late joiner replaying the ring would see a frame that everyone who
    // already left never got, and the two would disagree about the message.
    const channel = openStreamChannel({ messageId: 'm1' });
    channel.append(textDelta('kept'));
    channel.finish(false);
    channel.append(textDelta('dropped'));

    expect(channel.nextSeq).toBe(1);
    expect(channel.getFrames()).toEqual([textDelta('kept')]);
  });

  it('given unsubscribe, should stop delivering', () => {
    const channel = openStreamChannel({ messageId: 'm1' });
    const sub = collect(channel);
    channel.append(textDelta('before'));
    sub.unsubscribe();
    channel.append(textDelta('after'));

    expect(sub.frames).toHaveLength(1);
    expect(channel.subscriberCount).toBe(0);
  });
});

describe('stream-channel — eviction never hands out a silent gap', () => {
  it('given the ring evicted old frames, should advance firstAvailableSeq', () => {
    const channel = openStreamChannel({ messageId: 'm1', maxMemoryFrames: 2 });
    channel.append(textDelta('a'));
    channel.append(textDelta('b'));
    channel.append(textDelta('c'));

    expect(channel.firstAvailableSeq).toBe(1);
    expect(channel.getFrames().length).toBe(2);
  });

  it('given a subscriber asking for an evicted seq, should refuse with a resume point rather than silently starting later', () => {
    // The failure this prevents is the one the old skipReplayCount arithmetic produced: a
    // consumer handed a prefix it cannot tell is missing. Refusing is recoverable;
    // an invisible gap is not.
    const channel = openStreamChannel({ messageId: 'm1', maxMemoryFrames: 2 });
    channel.append(textDelta('a'));
    channel.append(textDelta('b'));
    channel.append(textDelta('c'));

    const sub = collect(channel, 0);

    expect(sub.frames).toEqual([]);
    expect(sub.end).toEqual({ reason: 'overflow', aborted: false, resumeFromSeq: 1 });
    expect(channel.subscriberCount).toBe(0);
  });

  it('given a subscriber asking for the oldest surviving seq, should serve it', () => {
    const channel = openStreamChannel({ messageId: 'm1', maxMemoryFrames: 2 });
    channel.append(textDelta('a'));
    channel.append(textDelta('b'));
    channel.append(textDelta('c'));

    expect(collect(channel, 1).frames.map((f) => f.seq)).toEqual([1, 2]);
  });

  it('given a large tool-output frame, should charge its REAL size against the budget', async () => {
    // The hole this closes: tool-output frames carry arbitrarily large payloads and have no
    // `delta`/`text` string, so a flat estimate charged a multi-megabyte result a few hundred
    // bytes. The byte budget then bounded nothing and the true worst case was
    // `maxMemoryFrames × actual size`. One oversized frame must be enough to evict on bytes.
    const channel = openStreamChannel({ messageId: 'm1', maxMemoryBytes: 50_000 });
    channel.append(textDelta('small'));
    channel.append(chunk({
      type: 'tool-output-available',
      toolCallId: 'tc1',
      output: { rows: Array.from({ length: 4000 }, (_, i) => ({ i, pad: 'xxxxxxxxxx' })) },
    }));

    expect(channel.firstAvailableSeq).toBeGreaterThan(0);
  });

  it('given a frame that cannot be serialized, should charge it against the budget rather than let it slip under', () => {
    // A circular payload makes JSON.stringify throw. Charging ~0 there would reopen the hole
    // for exactly the frames we cannot inspect.
    const circular: Record<string, unknown> = { type: 'tool-output-available', toolCallId: 'tc1' };
    circular.self = circular;
    const channel = openStreamChannel({ messageId: 'm1', maxMemoryBytes: 50_000 });
    channel.append(textDelta('small'));
    channel.append(circular as unknown as UIMessageChunk);

    expect(channel.firstAvailableSeq).toBeGreaterThan(0);
  });

  it('given a byte budget, should evict on bytes as well as count', () => {
    const channel = openStreamChannel({ messageId: 'm1', maxMemoryBytes: 200 });
    channel.append(textDelta('x'.repeat(100)));
    channel.append(textDelta('y'.repeat(100)));
    channel.append(textDelta('z'.repeat(100)));

    expect(channel.firstAvailableSeq).toBeGreaterThan(0);
  });
});

describe('stream-channel — subscribeReadable is an ordinary subscriber', () => {
  it('given a readable subscriber, should yield every frame then close', async () => {
    const channel = openStreamChannel({ messageId: 'm1' });
    const stream = channel.subscribeReadable({ fromSeq: 0 });

    channel.append(textDelta('a'));
    channel.append(textDelta('b'));
    channel.finish(false);

    expect(await readAll(stream)).toEqual([textDelta('a'), textDelta('b')]);
  });

  it('given the response reader cancelling mid-stream, should not stop capture', async () => {
    // The property the whole inversion exists for: a disconnecting client drops ONE
    // subscription; the channel keeps recording.
    const channel = openStreamChannel({ messageId: 'm1' });
    const stream = channel.subscribeReadable({ fromSeq: 0 });
    const reader = stream.getReader();

    channel.append(textDelta('seen'));
    await reader.read();
    await reader.cancel();

    channel.append(textDelta('after disconnect'));
    channel.append(textDelta('and more'));

    expect(channel.nextSeq).toBe(3);
    expect(channel.getFrames()).toHaveLength(3);
    expect(channel.subscriberCount).toBe(0);
  });

  it('given an aborted signal, should close the readable without ending the channel', async () => {
    const channel = openStreamChannel({ messageId: 'm1' });
    const controller = new AbortController();
    const stream = channel.subscribeReadable({ fromSeq: 0, signal: controller.signal });

    channel.append(textDelta('a'));
    controller.abort();

    expect(await readAll(stream)).toEqual([textDelta('a')]);
    channel.append(textDelta('still recording'));
    expect(channel.nextSeq).toBe(2);
    expect(channel.finished).toBe(false);
  });

  it('given a consumer that never reads, should stop buffering at the cap rather than growing without bound', async () => {
    const channel = openStreamChannel({ messageId: 'm1' });
    const stream = channel.subscribeReadable({ fromSeq: 0, maxPendingFrames: 3 });
    // Deliberately never read.

    for (let i = 0; i < 50; i += 1) channel.append(textDelta(`f${i}`));

    // The channel kept every frame; only this subscriber was dropped.
    expect(channel.nextSeq).toBe(50);
    expect(channel.subscriberCount).toBe(0);

    const delivered = await readAll(stream);
    expect(delivered.length).toBeLessThanOrEqual(3);
  });

  it('given a slow but healthy consumer, should NOT be cut off by the cap', async () => {
    // The bug an earlier draft had: monotonic counters that nothing decremented meant
    // every subscriber died partway through a long reply. Draining must credit back.
    const channel = openStreamChannel({ messageId: 'm1' });
    const stream = channel.subscribeReadable({ fromSeq: 0, maxPendingFrames: 4 });
    const reader = stream.getReader();

    const received: UIMessageChunk[] = [];
    for (let i = 0; i < 40; i += 1) {
      channel.append(textDelta(`f${i}`));
      const { value } = await reader.read();
      if (value) received.push(value);
    }
    channel.finish(false);

    expect(received).toHaveLength(40);
  });

  it('given a slow but healthy consumer, should credit BYTES back as well as frames', async () => {
    // The frame-count test above passes even if byte accounting is monotonic, because it
    // leaves maxPendingBytes at the default. Mutation-testing found the byte credit-back
    // unpinned: without it a healthy consumer is cut off once the stream's TOTAL size
    // crosses the budget, however promptly it reads.
    const channel = openStreamChannel({ messageId: 'm1' });
    const stream = channel.subscribeReadable({ fromSeq: 0, maxPendingBytes: 1_000 });
    const reader = stream.getReader();

    const received: UIMessageChunk[] = [];
    for (let i = 0; i < 30; i += 1) {
      channel.append(textDelta('x'.repeat(200)));
      const { value } = await reader.read();
      if (value) received.push(value);
    }
    channel.finish(false);

    // 30 * ~264 bytes is far past the 1 KB budget in total, but never more than one
    // frame is outstanding at a time.
    expect(received).toHaveLength(30);
  });

  it('given a readable joining after finish, should still replay everything', async () => {
    const channel = openStreamChannel({ messageId: 'm1' });
    channel.append(textDelta('a'));
    channel.append(textDelta('b'));
    channel.finish(false);

    expect(await readAll(channel.subscribeReadable({ fromSeq: 0 }))).toEqual([
      textDelta('a'),
      textDelta('b'),
    ]);
  });
});

describe('pumpSdkStreamToChannel', () => {
  it('given an SDK stream, should append every frame in order', async () => {
    const channel = openStreamChannel({ messageId: 'm1' });
    const frames = [
      chunk({ type: 'start', messageId: 'm1' }),
      textDelta('hello'),
      chunk({ type: 'finish' }),
    ];

    const result = await pumpSdkStreamToChannel(streamOf(frames), channel);

    expect(result).toEqual({ frameCount: 3 });
    expect(channel.getFrames()).toEqual(frames);
  });

  it('given an SDK stream that throws, should record a synthetic error frame instead of losing the failure', async () => {
    // A torn HTTP body tells only the one connected client. An error frame is part of the
    // durable record, so a tab that attaches afterwards learns why the stream stopped —
    // which is impossible today, because the projection dropped error chunks entirely.
    const channel = openStreamChannel({ messageId: 'm1' });
    // Errored from `pull`, not `start`: `controller.error()` discards anything still
    // queued, so enqueue-then-error in `start` would lose the partial frame before the
    // pump ever saw it and would test nothing.
    let pulls = 0;
    const failing = new ReadableStream<UIMessageChunk>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(textDelta('partial'));
          return;
        }
        controller.error(new Error('provider exploded'));
      },
    });

    const result = await pumpSdkStreamToChannel(failing, channel);

    expect(result.error).toBeInstanceOf(Error);
    expect(channel.getFrames()).toEqual([
      textDelta('partial'),
      chunk({ type: 'error', errorText: 'provider exploded' }),
    ]);
  });

  it('given no subscribers at all, should still capture every frame', async () => {
    // The AFK case, stated as a test: nobody is listening and the record is complete.
    const channel = openStreamChannel({ messageId: 'm1' });
    const frames = Array.from({ length: 100 }, (_, i) => textDelta(`f${i}`));

    await pumpSdkStreamToChannel(streamOf(frames), channel);

    expect(channel.nextSeq).toBe(100);
    expect(channel.getFrames()).toHaveLength(100);
  });
});

describe('stream-channel-registry', () => {
  const meta = {
    pageId: 'p1',
    userId: 'u1',
    displayName: 'Jono',
    conversationId: 'c1',
    browserSessionId: 'b1',
  };

  it('given an opened channel, should be findable by messageId with its meta', () => {
    const registry = new StreamChannelRegistry();
    const channel = registry.open('m1', meta);

    expect(registry.get('m1')).toBe(channel);
    expect(registry.getMeta('m1')).toEqual(meta);
    registry.reset();
  });

  it('given an unknown messageId, should return undefined rather than throw', () => {
    const registry = new StreamChannelRegistry();
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.getMeta('nope')).toBeUndefined();
  });

  it('given a re-opened messageId, should finish the previous channel rather than strand its subscribers', () => {
    // The retry / takeover path. Silently replacing the entry would leave the old
    // channel's subscribers waiting forever on a stream nothing will ever finish.
    const registry = new StreamChannelRegistry();
    const first = registry.open('m1', meta);
    let firstEnd: string | null = null;
    first.subscribe({
      fromSeq: 0,
      onFrame: () => {},
      onEnd: (end) => {
        firstEnd = end.reason;
      },
    });

    const second = registry.open('m1', meta);

    expect(firstEnd).toBe('finished');
    expect(first.finished).toBe(true);
    expect(registry.get('m1')).toBe(second);
    expect(second.finished).toBe(false);
    registry.reset();
  });

  it('given close, should finish the channel and drop the entry, and be idempotent', () => {
    const registry = new StreamChannelRegistry();
    const channel = registry.open('m1', meta);

    registry.close('m1', true);
    expect(channel.finished).toBe(true);
    expect(channel.aborted).toBe(true);
    expect(registry.get('m1')).toBeUndefined();

    expect(() => registry.close('m1', true)).not.toThrow();
  });

  it('given two messageIds, should keep their channels independent', () => {
    const registry = new StreamChannelRegistry();
    const a = registry.open('m1', meta);
    const b = registry.open('m2', meta);

    a.append(textDelta('only a'));

    expect(a.nextSeq).toBe(1);
    expect(b.nextSeq).toBe(0);
    registry.close('m1');
    expect(registry.get('m2')).toBe(b);
    registry.reset();
  });
});
