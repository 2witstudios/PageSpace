/**
 * WHO FINISHES A STREAM THE SDK NEVER FINISHES.
 *
 * `createUIMessageStream`'s `onFinish` runs the terminal block, and it fires from the SDK's
 * final transform's `flush()`. A stream that ERRORS never reaches flush — so on the one path
 * where the SDK's own reduction throws, nothing ran the block at all. The pump folded the
 * failure into a durable error frame and resolved with `{ error }`; `pumpAndRespond` threw
 * that result away.
 *
 * The observable consequence was not a lost error message — the error frame reached every
 * subscriber. It was that the stream never ENDED: the channel stayed open, so the response
 * body and every SSE joiner parked on a generation that had already failed, and the session
 * row stayed `'streaming'`.
 *
 * These tests pin the failure path and, just as importantly, pin that the SUCCESS path does
 * not run it — a terminalizer that fires on every stream would double-finish every turn and
 * make `onFinish`'s own accounting race its own cleanup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UIMessageChunk } from 'ai';

const removeStream = vi.fn();
vi.mock('@/lib/ai/core/stream-abort-registry', () => ({
  removeStream: (args: { streamId: string }) => removeStream(args),
  STREAM_ID_HEADER: 'X-Stream-Id',
}));

import { pumpAndRespond } from '@/lib/ai/chat-pipeline/pump-and-respond';
import { openStreamChannel } from '@/lib/ai/core/stream-channel';
import type { StreamLifecycleHandle } from '@/lib/ai/core/stream-lifecycle';

const chunk = (value: unknown): UIMessageChunk => value as UIMessageChunk;

/**
 * A lifecycle over a REAL channel. `finish` records its argument and closes the channel the
 * way the real one does, so "did every subscriber end" is answerable rather than assumed.
 */
const fakeLifecycle = (): {
  handle: StreamLifecycleHandle;
  finishCalls: boolean[];
  channel: ReturnType<typeof openStreamChannel>;
} => {
  const channel = openStreamChannel({ messageId: 'msg-1' });
  const finishCalls: boolean[] = [];
  const handle: StreamLifecycleHandle = {
    channel,
    finish: (aborted: boolean) => {
      finishCalls.push(aborted);
      channel.finish(aborted);
    },
    getParts: async () => [],
    // Unused here: this module never persists a message, so it never confirms one. Present
    // only to satisfy the handle's shape.
    confirmTerminalWrite: () => {},
    preAborted: false,
  };
  return { handle, finishCalls, channel };
};

/** Let the un-awaited pump promise and its continuation settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(() => {
  removeStream.mockClear();
});

describe('pumpAndRespond — a pump that fails still ends the stream', () => {
  it('finishes the lifecycle when the SDK stream errors mid-generation', async () => {
    const { handle, finishCalls, channel } = fakeLifecycle();
    // The documented failure: the SDK's own reduction throws on a malformed frame
    // sequence, erroring the stream rather than completing it.
    const sdkStream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue(chunk({ type: 'text-start', id: 't1' }));
      },
      pull() {
        throw new Error('tool result names a call that never started');
      },
    });

    pumpAndRespond({ sdkStream, lifecycle: handle, streamId: 'stream-1' });
    await settle();

    expect(
      finishCalls,
      'the stream errored, so onFinish never fired — nothing else was going to finish it',
    ).toEqual([false]);
    expect(channel.finished).toBe(true);
  });

  it('releases the abort-registry entry the SDK terminal block would have released', async () => {
    const { handle } = fakeLifecycle();
    const sdkStream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.error(new Error('provider stream failed'));
      },
    });

    pumpAndRespond({ sdkStream, lifecycle: handle, streamId: 'stream-2' });
    await settle();

    expect(removeStream).toHaveBeenCalledWith({ streamId: 'stream-2' });
  });

  it('ends every subscriber rather than parking them on a dead generation', async () => {
    // The user-visible half. Without terminalization the response body never closes.
    const { handle } = fakeLifecycle();
    const sdkStream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.error(new Error('boom'));
      },
    });

    const response = pumpAndRespond({ sdkStream, lifecycle: handle, streamId: 'stream-3' });
    const body = response.body;
    expect(body).not.toBeNull();

    // `createUIMessageStreamResponse` serializes to SSE, so this drains bytes.
    const reader = body!.getReader();
    const decoder = new TextDecoder();
    let sse = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) sse += decoder.decode(value, { stream: true });
    }

    // Reaching here at all is the assertion — an unterminalized channel never closes,
    // so this loop would hang rather than complete. The error frame's presence is the
    // second half: the client is told WHY it stopped, not just that it did.
    expect(sse).toContain('"type":"error"');
    expect(sse).toContain('boom');
  });

  it('does NOT finish the lifecycle when the stream completes normally', async () => {
    // onFinish owns the terminal block on the happy path, including the credit settle this
    // seam cannot perform. Firing here too would race it.
    const { handle, finishCalls } = fakeLifecycle();
    const sdkStream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue(chunk({ type: 'text-start', id: 't1' }));
        controller.enqueue(chunk({ type: 'text-delta', id: 't1', delta: 'hello' }));
        controller.close();
      },
    });

    pumpAndRespond({ sdkStream, lifecycle: handle, streamId: 'stream-4' });
    await settle();

    expect(finishCalls).toEqual([]);
    expect(removeStream).not.toHaveBeenCalled();
  });
});
