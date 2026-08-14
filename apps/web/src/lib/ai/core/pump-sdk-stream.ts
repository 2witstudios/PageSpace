import type { UIMessageChunk } from 'ai';
import type { StreamChannel } from '@/lib/ai/core/stream-channel';

interface PumpLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface PumpResult {
  /** Frames appended to the channel. */
  frameCount: number;
  /** Set when the SDK stream threw rather than completing. */
  error?: unknown;
}

/**
 * Read a `createUIMessageStream` output to completion, appending every frame to the
 * channel. This is the ONLY reader of that stream.
 *
 * That is the whole point. When the response body was the reader, capture was coupled to
 * whether a client was still listening: a disconnect cancelled the body, the cancel
 * propagated upstream, and the durable copy stopped growing while `execute` kept running.
 * Here nothing downstream can reach the SDK stream, so a client leaving is invisible to
 * capture.
 *
 * DELIBERATELY NOT AWAITED by the route. It is kicked off with `void` and self-drives:
 * the route's job is to return a response, and the pump outlives it. It never rejects —
 * every failure is folded into the channel and the returned result.
 *
 * KNOWN CONSEQUENCE, verify before shipping: with the pump as sole reader, the SDK's
 * final transform never runs its `cancel()` path, only `flush()`. `onFinish` therefore
 * stops firing early on client disconnect (today it does, settling credits against a
 * truncated `state.message` and removing the abort-registry entry while the generation is
 * still running). That is more correct, but it lengthens credit-hold lifetime on
 * disconnect and shifts when the abort registry's `recentlyFinished` tombstone is written.
 */
export const pumpSdkStreamToChannel = async (
  sdkStream: ReadableStream<UIMessageChunk>,
  channel: StreamChannel,
  logger?: PumpLogger,
): Promise<PumpResult> => {
  const reader = sdkStream.getReader();
  let frameCount = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      channel.append(value);
      frameCount += 1;
    }
    return { frameCount };
  } catch (error) {
    // The SDK's own reduction throws (`UIMessageStreamError`) on a malformed frame
    // sequence — e.g. a tool result naming a call it never saw start — and that errors
    // the whole stream. Append a synthetic error frame so the failure is part of the
    // durable record rather than only a torn HTTP body: every subscriber, including one
    // that attaches after the fact, then sees why the stream stopped.
    const errorText = error instanceof Error ? error.message : 'Stream failed';
    try {
      channel.append({ type: 'error', errorText } as UIMessageChunk);
      frameCount += 1;
    } catch {
      // Channel already finished — nothing more to record.
    }
    logger?.warn('pumpSdkStreamToChannel: SDK stream failed', {
      messageId: channel.messageId,
      frameCount,
      error: errorText,
    });
    return { frameCount, error };
  } finally {
    // Release the lock but do NOT cancel: cancelling would propagate upstream into
    // `createUIMessageStream` and, on the error path, tear down machinery that is still
    // unwinding. The stream is finished or errored either way.
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
};
