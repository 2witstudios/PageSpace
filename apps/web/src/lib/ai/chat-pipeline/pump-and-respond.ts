import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { pumpSdkStreamToChannel } from '@/lib/ai/core/pump-sdk-stream';
import { STREAM_ID_HEADER } from '@/lib/ai/core/stream-abort-registry';
import type { StreamLifecycleHandle } from '@/lib/ai/core/stream-lifecycle';

/**
 * Caps for the HTTP response subscriber.
 *
 * It is the only subscriber with no resume path: every other one can be dropped and told a seq
 * to reconnect from, but cutting this one truncates a user's visible reply. So it buys far more
 * headroom before the channel gives up on it. The code this replaces had no bound here at all —
 * the SDK's own queue grew unchecked — so this is a tightening, just deliberately not an
 * aggressive one.
 */
const RESPONSE_MAX_PENDING_FRAMES = 200_000;
const RESPONSE_MAX_PENDING_BYTES = 64 * 1024 * 1024;

/**
 * Hand the SDK stream to the pump and return a response that SUBSCRIBES to the channel.
 *
 * Shared by both turn strategies because it is identical in each, and the duplication ratchet
 * (`turn-duplication-ratchet.test.ts`) correctly refused the copy — `start-chat-generation.ts`
 * is the precedent it names.
 *
 * WHAT THIS BUYS. The pump becomes the SOLE reader of the SDK stream, which makes capture
 * independent of whether anyone is listening. While the response body was the reader, a client
 * hanging up cancelled it, the cancel propagated up the SDK's transform chain, and `onFinish`
 * fired EARLY — running each turn's whole terminal block (lifecycle.finish → session row
 * terminal, parts cleared, `chat:stream_complete` broadcast to every subscriber, plus
 * removeStream and credit settlement) while `execute` was still generating, still calling write
 * tools and still billing. `aborted` computes false there, so the row was even marked
 * 'complete'. That was never only tab-close: `useConversationSendHandoff` calls `stop()` on any
 * cross-conversation send, so the ordinary "send in A, switch to B, send in B" flow triggered
 * it. `onfinish-cancel-semantics.test.ts` pins both the old behaviour and this fix.
 *
 * TWO DELIBERATE OMISSIONS, both load-bearing:
 *
 *   - The pump is NOT awaited. It outlives the request; the caller's job is to return a
 *     response, not to wait for a generation.
 *   - No `request.signal` is passed to `subscribeReadable`. `disconnect-immunity.test.ts` is a
 *     source-level tripwire forbidding the generation path from naming it, and it is redundant
 *     anyway: cancelling the response `ReadableStream` already detaches this subscriber. See
 *     `SubscribeReadableOptions` in stream-channel.ts.
 */
export const pumpAndRespond = ({
  sdkStream,
  lifecycle,
  streamId,
}: {
  sdkStream: ReadableStream<UIMessageChunk>;
  lifecycle: StreamLifecycleHandle;
  streamId: string;
}): Response => {
  void pumpSdkStreamToChannel(sdkStream, lifecycle.channel, loggers.ai);

  return createUIMessageStreamResponse({
    stream: lifecycle.channel.subscribeReadable({
      fromSeq: 0,
      maxPendingFrames: RESPONSE_MAX_PENDING_FRAMES,
      maxPendingBytes: RESPONSE_MAX_PENDING_BYTES,
    }),
    headers: { [STREAM_ID_HEADER]: streamId },
  });
};
