/**
 * Client-side Stream Abort Management
 *
 * Tracks active streams and provides explicit abort functionality.
 * Works with the server-side abort registry to enable user-initiated stop
 * while allowing streams to complete on accidental disconnects.
 *
 * Usage:
 * 1. Use createStreamTrackingFetch() to create a fetch wrapper
 * 2. Pass the wrapper to DefaultChatTransport
 * 3. Call abortActiveStream() when user clicks stop
 */

import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { getBrowserSessionId } from './browser-session-id';
import {
  markChannelConsuming,
  unmarkChannelConsuming,
} from '@/lib/ai/streams/consumingChannels';
import type { AbortCode } from '@/lib/ai/core/stream-abort-decisions';
import { toErrorCause } from '@/lib/ai/shared/toErrorCause';

/**
 * What the server says happened.
 *
 * `code` exists because `aborted: false` used to mean two entirely different things, and every
 * caller discarded it anyway (`void abortActiveStream(...)`) — so the button flipped back to Send
 * no matter what actually happened on the server:
 *
 *   - 'not_found'   — nothing was in flight. The stream finished a beat before Stop was pressed.
 *                     A BENIGN race. Must stay SILENT: it fires often, and a toast here would
 *                     train users to ignore the one below.
 *   - 'unconfirmed' — the stream was found, the abort was requested, and it is STILL GENERATING.
 *                     Still calling write tools. Still billing. The user must be told.
 *
 * Codes, not `reason` substrings. The old code sniffed for 'not found' / 'already completed' in a
 * prose string, which is a contract nobody can see they are breaking when they reword a log line.
 */
export interface AbortResult {
  aborted: boolean;
  code: AbortCode;
  reason: string;
}

/**
 * A failure to even reach the abort endpoint is not ambiguous: the server never heard the Stop, so
 * the generation is definitely still running, and still billing. That is exactly 'unconfirmed'.
 */
const NETWORK_FAILURE: AbortResult = {
  aborted: false,
  code: 'unconfirmed',
  reason: 'Failed to call abort endpoint',
};

const parseAbortResult = async (response: Response): Promise<AbortResult> => {
  const body = await response.json();

  if (!body || typeof body.code !== 'string') {
    // The endpoint answered with something we do not understand (an error envelope, a proxy page).
    // We cannot claim the stream stopped.
    return { aborted: false, code: 'unconfirmed', reason: 'Unrecognized abort response' };
  }

  return body as AbortResult;
};

/**
 * Surface an abort outcome to the user — and only when it is worth surfacing.
 *
 * Call this from USER-INITIATED Stop paths. It deliberately says nothing on 'not_found': the
 * stream had already finished, which is not something the user did wrong and not something they
 * can act on.
 */
export const reportAbortOutcome = (result: AbortResult): void => {
  reportAbortOutcomes([result]);
};

/**
 * The same, for a Stop that fires more than one abort (a surface that must name a stream under two
 * possible keys). One toast at most, however many of them come back unconfirmed — they are all the
 * same stream, and the user does not need to be told twice.
 */
export const reportAbortOutcomes = (results: readonly AbortResult[]): void => {
  if (!results.some((result) => result.code === 'unconfirmed')) return;

  toast.warning('Could not confirm the generation stopped', {
    description: 'It may still be running. Reload to see its current state.',
  });
};

// NO activeStreams chatId->streamId MAP (PR 5A, leaf 5.5.8).
//
// It existed so Stop could name a generation precisely. It could not:
//   - It was populated only once the response HEADERS landed. A real send spends 0.5-3s before
//     that, which is exactly when a user who spotted a typo hits Stop — the map was EMPTY.
//   - It was torn down by each surface's conversation-change cleanup, so a Stop after a
//     mid-stream switch was a map MISS.
//   - It was keyed by a transport-local chatId that surfaces had to keep unique by hand (hence
//     the sidebar's `sidebar:<convId>` namespace), and one surface's cleanup could delete
//     another's entry.
// In every one of those windows the abort silently no-op'd: the local fetch stopped, the button
// flipped back to Send, and the server — which deliberately survives client disconnect — kept
// generating, kept running write tools, and kept billing.
//
// Both replacements are names nobody has to maintain a map for: the assistant messageId (recorded
// in usePendingStreamsStore at stream_start, immune to the surface moving) and the conversationId
// captured at send. See decideStopAction.
/**
 * Abort by CONVERSATION — the only name the client holds from t=0.
 *
 * Both `streamId` and `messageId` are minted server-side, and the client does not learn either
 * until the response headers land. A real agent send spends 0.5-3 seconds before that (auth,
 * rate limit, DB reads, context assembly, connecting to the provider). Stop pressed in that
 * window — precisely when a user who has spotted a typo presses it — had NOTHING to name: the
 * `activeStreams` map was empty, the abort was a guaranteed no-op, the local fetch was cancelled,
 * and the button flipped back to Send.
 *
 * And cancelling the fetch stops nothing. Streams are deliberately server-owned and survive a
 * client disconnect — that is the whole architecture. So the generation kept running, kept
 * calling write tools, and kept BILLING, while the UI told the user it had stopped.
 *
 * This is the fallback that makes Stop always able to say something true. Server-side it only
 * ever stops the caller's OWN streams (see abort-conversation-streams.ts).
 */
export const abortActiveStreamByConversation = async ({
  conversationId,
}: {
  conversationId: string;
}): Promise<AbortResult> => {
  try {
    const response = await fetchWithAuth('/api/ai/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    });
    return await parseAbortResult(response);
  } catch {
    return NETWORK_FAILURE;
  }
};

export const abortActiveStreamByMessageId = async ({
  messageId,
}: {
  messageId: string;
}): Promise<AbortResult> => {
  try {
    const response = await fetchWithAuth('/api/ai/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId }),
    });
    return await parseAbortResult(response);
  } catch {
    return NETWORK_FAILURE;
  }
};

/**
 * Re-wraps a streaming response so `onDone` fires exactly once, when the body is
 * genuinely finished — closed, errored, or cancelled. `fetch` resolving only tells
 * us the headers landed; the tokens are still arriving after that.
 */
const withBodyCompletion = (response: Response, onDone: () => void): Response => {
  const body = response.body;
  if (!body) {
    onDone();
    return response;
  }

  let done = false;
  const finishOnce = () => {
    if (done) return;
    done = true;
    onDone();
  };

  const reader = body.getReader();
  const tracked = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) {
          finishOnce();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        finishOnce();
        controller.error(error);
      }
    },
    cancel(reason) {
      finishOnce();
      return reader.cancel(reason);
    },
  });

  return new Response(tracked, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/**
 * Create a fetch wrapper that tracks streamId from response headers
 * Use this with DefaultChatTransport
 *
 * `channelId` (the socket room the server broadcasts this stream's lifecycle on —
 * NOT the same value as `chatId`, which is a transport-local key) is marked as
 * "being consumed by this browser context" for exactly as long as this client is
 * reading tokens off the response body. That is the one signal that makes the
 * client's own `chat:stream_start` uninteresting; without it we'd render every
 * token twice. See `consumingChannels.ts` for why this replaces the old
 * `browserSessionId` check.
 */
export const createStreamTrackingFetch = ({
  getChannelId,
}: {
  /**
   * Resolved AT CALL TIME, not at construction. This is not a style choice.
   *
   * useChat only rebuilds its `Chat` when its `id` changes (@ai-sdk/react:
   * `shouldRecreateChat`), and every surface here passes a CONSTANT id. The `Chat` binds
   * `this.transport` once in its constructor and calls `this.transport.sendMessages()`
   * forever after — so the first transport a surface ever builds is the only one it will
   * ever use, and every later one is constructed and thrown away.
   *
   * Baking `channelId` into this closure therefore froze it at whatever agent the surface
   * happened to start with: after an agent switch the wrong channel got marked as consuming, so
   * the tab failed to recognise its OWN stream on the socket, joined its own multicast, and
   * rendered the reply twice.
   *
   * (`getChatId` is gone with the activeStreams map — PR 5A, leaf 5.5.8. It had the same
   * staleness bug, with a worse consequence: the abort silently named nothing and the server
   * kept billing.)
   */
  getChannelId: () => string | undefined;
}): typeof fetch => {
  return async (url, options) => {
    const channelId = getChannelId();
    const urlString = url instanceof Request ? url.url : url.toString();
    const merged = new Headers(options?.headers);
    merged.set('X-Browser-Session-Id', getBrowserSessionId());
    const headers = Object.fromEntries(merged.entries());

    // Marked BEFORE the request leaves, so it can never lose the race against the
    // server's broadcastAiStreamStart (which is why this is not derived from the
    // X-Stream-Id response header).
    if (channelId) markChannelConsuming(channelId);

    let response: Response;
    try {
      response = await fetchWithAuth(urlString, { ...options, headers });
    } catch (error) {
      if (channelId) unmarkChannelConsuming(channelId);
      throw error;
    }

    // NOTE: the X-Stream-Id response header is no longer read here. It fed the activeStreams map,
    // whose only consumer was an abort-by-chatId path that could not work in the windows that
    // mattered (see the map's deletion note above). The server still sends it.

    if (!response.ok) {
      if (channelId) unmarkChannelConsuming(channelId);
      // Epic leaf 6.5: read the body ONCE here (where httpStatus + the real JSON are both in
      // hand) and throw a typed cause rather than letting the SDK construct a bare
      // `new Error(await response.text())` from a re-read of the same body. `response.clone()`
      // is required — the SDK's own transport still expects to be able to read a body if it
      // ever got the Response itself, but throwing here means it never does; kept only for
      // defense (a future SDK version that inspects the response before the fetch promise even
      // resolves would otherwise see an already-consumed stream).
      const body = await response.clone().json().catch(() => undefined);
      const cause = toErrorCause(response.status, body);
      throw new Error(cause.message, { cause });
    }

    if (!channelId) return response;

    const consumedChannelId = channelId;
    return withBodyCompletion(response, () => {
      unmarkChannelConsuming(consumedChannelId);
    });
  };
};

