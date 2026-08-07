import { describe, it, expect } from 'vitest';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessageChunk,
} from 'ai';
import { openStreamChannel } from '@/lib/ai/core/stream-channel';
import { pumpSdkStreamToChannel } from '@/lib/ai/core/pump-sdk-stream';

/**
 * WHEN DOES `onFinish` FIRE?
 *
 * `handleUIMessageStreamFinish` (ai@6, dist/index.mjs) calls `onFinish` from BOTH the final
 * transform's `flush()` AND its `cancel()`, guarded by a `finishCalled` flag. So whether a
 * disconnecting client fires `onFinish` early depends on whether the cancel actually
 * propagates back up the pipe chain.
 *
 * That is not a detail. Both generation routes end `onFinish` with `lifecycle.finish(aborted)`,
 * which drives the `ai_stream_sessions` row terminal, clears its parts snapshot, and
 * broadcasts `chat:stream_complete` to every subscriber — and it also calls
 * `removeStream({streamId})`, dropping the abort-registry entry, and settles credits. If a
 * client hanging up runs all of that while `execute` is still generating, then a disconnect
 * silently tells everyone else the stream ended.
 *
 * These tests answer the question by experiment against the real SDK rather than by reading
 * it, and they pin the answer so a future SDK upgrade cannot change it quietly.
 */

const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Builds a stream whose `execute` we can advance step by step from the test. */
const buildControllableStream = (): {
  stream: ReadableStream<UIMessageChunk>;
  writeOne: (text: string) => Promise<void>;
  finishExecute: () => void;
  onFinishCalls: { at: string }[];
  executeFinished: () => boolean;
} => {
  const onFinishCalls: { at: string }[] = [];
  let executeDone = false;
  let release: (() => void) | null = null;
  let pushChunk: ((text: string) => void) | null = null;

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: 'start' } as UIMessageChunk);
      pushChunk = (text: string) => {
        // Writes after a cancel must not throw — the SDK swallows them (safeEnqueue), which
        // is what keeps `execute` alive after the reader is gone.
        writer.write({ type: 'text-start', id: text } as UIMessageChunk);
        writer.write({ type: 'text-delta', id: text, delta: text } as UIMessageChunk);
        writer.write({ type: 'text-end', id: text } as UIMessageChunk);
      };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      executeDone = true;
    },
    onFinish: () => {
      onFinishCalls.push({ at: executeDone ? 'after-execute' : 'during-execute' });
    },
  });

  return {
    stream,
    writeOne: async (text: string) => {
      pushChunk?.(text);
      await nextTick();
    },
    finishExecute: () => release?.(),
    onFinishCalls,
    executeFinished: () => executeDone,
  };
};

describe('onFinish and stream cancellation — the semantics the routes depend on', () => {
  it('given the response body is cancelled mid-generation, should fire onFinish EARLY (the behaviour the inversion removes)', async () => {
    const harness = buildControllableStream();
    const response = createUIMessageStreamResponse({ stream: harness.stream });

    const reader = response.body!.getReader();
    await harness.writeOne('one');
    await reader.read();

    // The client hangs up.
    await reader.cancel();
    await nextTick();
    await nextTick();

    expect(
      harness.onFinishCalls,
      'If this is empty, cancel() does NOT propagate to the SDK\'s final transform in this '
      + 'runtime, and the early-onFinish concern is moot. If it fired during-execute, then a '
      + 'disconnecting client currently runs the routes\' whole onFinish — lifecycle.finish(), '
      + 'broadcastAiStreamComplete, removeStream(), credit settlement — while the generation '
      + 'is still running.',
    ).toEqual([{ at: 'during-execute' }]);

    expect(harness.executeFinished()).toBe(false);

    harness.finishExecute();
    await nextTick();
  });

  it('given the pump owns the stream, should NOT fire onFinish when a subscriber disconnects', async () => {
    // The inversion: the pump is the sole reader, so a subscriber going away cancels its own
    // ReadableStream and never reaches the SDK's transform chain.
    const harness = buildControllableStream();
    const channel = openStreamChannel({ messageId: 'm1' });
    void pumpSdkStreamToChannel(harness.stream, channel);

    const responseStream = channel.subscribeReadable({ fromSeq: 0 });
    const response = createUIMessageStreamResponse({ stream: responseStream });
    const reader = response.body!.getReader();

    await harness.writeOne('one');
    await reader.read();
    await reader.cancel();
    await nextTick();
    await nextTick();

    expect(harness.onFinishCalls).toEqual([]);
    expect(harness.executeFinished()).toBe(false);

    // And capture continues with nobody listening — the whole point.
    await harness.writeOne('two');
    await harness.writeOne('three');
    expect(channel.nextSeq).toBeGreaterThan(4);

    harness.finishExecute();
    await nextTick();
    await nextTick();

    expect(harness.onFinishCalls).toEqual([{ at: 'after-execute' }]);
  });

  it('given the pump owns the stream and nobody ever subscribes, should still fire onFinish exactly once at completion', async () => {
    const harness = buildControllableStream();
    const channel = openStreamChannel({ messageId: 'm1' });
    const pumped = pumpSdkStreamToChannel(harness.stream, channel);

    await harness.writeOne('alone');
    harness.finishExecute();
    await pumped;
    await nextTick();

    expect(harness.onFinishCalls).toEqual([{ at: 'after-execute' }]);
  });
});
