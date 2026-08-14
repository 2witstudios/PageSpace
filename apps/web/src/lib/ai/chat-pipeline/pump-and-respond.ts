import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { pumpSdkStreamToChannel, type PumpResult } from '@/lib/ai/core/pump-sdk-stream';
import { STREAM_ID_HEADER, removeStream } from '@/lib/ai/core/stream-abort-registry';
import type { StreamLifecycleHandle } from '@/lib/ai/core/stream-lifecycle';
import {
  ADMISSION_ENVELOPE_CONTENT_TYPE,
  STREAM_MODE_DETACHED,
  wantsDetachedStream,
  type StreamAdmissionEnvelope,
} from '@/lib/ai/core/detached-stream-mode';

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
 * Hand the SDK stream to the pump and return either an ADMISSION ENVELOPE (detached mode) or
 * a response that SUBSCRIBES to the channel (legacy mode).
 *
 * Shared by both turn strategies because it is identical in each, and the duplication ratchet
 * (`turn-duplication-ratchet.test.ts`) correctly refused the copy — `start-chat-generation.ts`
 * is the precedent it names. The detached branch lives HERE, in the one shared function, for
 * the same reason: pasting the mode check into both strategies is precisely the copy the
 * ratchet exists to catch, and the two turns have no reason to disagree about it.
 *
 * ── WHICH BRANCH, AND WHY THE DEFAULT IS THE LEGACY ONE ───────────────────────────────────
 *
 * The client states what it can consume via `X-Stream-Mode: detached`. Absent that header the
 * body is streamed exactly as before — which is what keeps an OLD CLIENT working against a
 * NEW SERVER, including a tab left open across a deploy. The server never volunteers the
 * envelope. See `detached-stream-mode.ts` for the mirror case (new client, old server).
 *
 * NOTHING ABOUT CAPTURE CHANGES BETWEEN THE BRANCHES. The pump is the sole reader of the SDK
 * stream in both, so the generation is equally independent of whether anyone is listening;
 * the difference is only whether this response is subscriber #0 or a receipt. That is why the
 * detached branch can simply decline to subscribe rather than having to arrange anything.
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
 *
 *     THIS MODULE NOW TAKES A `Request`, AND READS EXACTLY ONE THING FROM IT: the
 *     `X-Stream-Mode` header. That makes it the nearest thing in the generation path to a
 *     place where somebody could "helpfully" add `request.signal` and revert the system to
 *     client-owned streams — the disconnect-immunity tripwire watches the two ROUTE files,
 *     not this one, so it would not catch it here. It is redundant here for the same reason
 *     it is redundant in the routes, and it is catastrophic for the reason that test's
 *     docblock spells out. Read the header. Read nothing else.
 *
 * NOT AWAITED IS NOT THE SAME AS NOT OBSERVED — see `terminalizeOnPumpFailure`.
 */
export const pumpAndRespond = ({
  sdkStream,
  lifecycle,
  streamId,
  request,
  channelId,
  conversationId,
}: {
  sdkStream: ReadableStream<UIMessageChunk>;
  lifecycle: StreamLifecycleHandle;
  streamId: string;
  /** Read for `X-Stream-Mode` ONLY — never for its abort signal. See the note below. */
  request: Request;
  /** The socket room this generation broadcasts on; rides the envelope. */
  channelId: string;
  /** The conversation being answered into; rides the envelope. */
  conversationId: string;
}): Response => {
  terminalizeOnPumpFailure({
    pump: pumpSdkStreamToChannel(sdkStream, lifecycle.channel, loggers.ai),
    lifecycle,
    streamId,
  });

  if (wantsDetachedStream(request.headers)) {
    // A RECEIPT, not a stream. The generation is already running and already recording into
    // the channel; this tells the client what to subscribe to. `startedAt` is stamped here
    // rather than read off the lifecycle, which does not expose it — it trails the row's own
    // start by the microseconds between `createStreamLifecycle` returning and this line, and
    // its only client-side jobs (stamping a synthesized bubble's `createdAt`, and driving the
    // store entry's expiry sweep) are indifferent to that.
    const envelope: StreamAdmissionEnvelope = {
      mode: STREAM_MODE_DETACHED,
      messageId: lifecycle.channel.messageId,
      conversationId,
      channelId,
      streamId,
      startedAt: new Date().toISOString(),
    };

    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: {
        'content-type': ADMISSION_ENVELOPE_CONTENT_TYPE,
        [STREAM_ID_HEADER]: streamId,
      },
    });
  }

  return createUIMessageStreamResponse({
    stream: lifecycle.channel.subscribeReadable({
      fromSeq: 0,
      maxPendingFrames: RESPONSE_MAX_PENDING_FRAMES,
      maxPendingBytes: RESPONSE_MAX_PENDING_BYTES,
    }),
    headers: { [STREAM_ID_HEADER]: streamId },
  });
};

/**
 * Watch the un-awaited pump and run the terminal block itself when it fails.
 *
 * WHO NORMALLY FINISHES A STREAM. `createUIMessageStream`'s `onFinish` — it calls
 * `removeStream`, settles the credit hold via `trackUsage`, and ends with
 * `lifecycle.finish`. It fires from the SDK's final transform's `flush()`.
 *
 * A REJECTED `read()` NEVER REACHES `flush()`. When the SDK's own reduction throws — the
 * documented malformed tool-frame sequence, or a provider stream failing outright — the
 * stream ERRORS instead of completing, so no flush runs and `onFinish` never fires. The
 * pump folds that into a synthetic error frame and resolves with `{ error }` rather than
 * rejecting, which is correct for the durable record and useless if nobody reads it: with
 * the result discarded, NOTHING terminalized the stream. The channel stayed open, so the
 * HTTP response body and every SSE joiner parked forever on a generation that had already
 * failed; the session row stayed `'streaming'`, so it kept being served as live, blocked
 * the next send's takeover, and left the abort-registry entry standing.
 *
 * So the failure path runs the two halves of that block this module can reach.
 * `lifecycle.finish(false)` is the one that matters: it closes the channel (ending every
 * subscriber at a known point, with the error frame already in the record they read),
 * drives the row terminal, and broadcasts `chat:stream_complete`. `false` because this is
 * a failure, not a user stop — the same value the ordinary error path produces, where an
 * exception inside `execute` becomes an error chunk and `onFinish` still computes
 * `aborted === false`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: settle the credit hold. That needs the turn's usage
 * accounting — `holdId`, accumulated tokens, the provider's cost — none of which exists at
 * this seam, and inventing a zero-usage settle here would bill the turn wrongly rather than
 * leave it to the sweep that already covers an unreleased hold. Named so the omission is a
 * decision rather than an oversight.
 *
 * Both calls are idempotent (`finish` returns early once finished; `removeStream` is a
 * delete), so this is harmless in the race where `onFinish` did fire after all.
 */
const terminalizeOnPumpFailure = ({
  pump,
  lifecycle,
  streamId,
}: {
  pump: Promise<PumpResult>;
  lifecycle: StreamLifecycleHandle;
  streamId: string;
}): void => {
  const terminalize = (error: unknown): void => {
    // Cleanup BEFORE the log. This function exists to be the last thing standing between a
    // failed generation and an indefinite hang, so the two calls that end it must not sit
    // downstream of anything that could throw first — including a logger.
    removeStream({ streamId });
    lifecycle.finish(false);
    loggers.ai.error(
      'pumpAndRespond: SDK pump failed — finished the lifecycle the SDK never will',
      error instanceof Error ? error : new Error(String(error)),
      { messageId: lifecycle.channel.messageId, streamId },
    );
  };

  // Two-argument `then` rather than `.then().catch()`: the rejection handler must cover the
  // PUMP rejecting, not a throw from the resolution handler above it. The pump documents
  // that it never rejects; this is the belt to that braces, because the failure a broken
  // promise contract would produce here is precisely the indefinite hang above.
  void pump.then(
    (result) => {
      if (result.error !== undefined) terminalize(result.error);
    },
    (error: unknown) => terminalize(error),
  );
};
