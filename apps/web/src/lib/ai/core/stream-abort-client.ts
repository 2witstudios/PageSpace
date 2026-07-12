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

// Track active streams by chat/conversation ID
const activeStreams = new Map<string, string>();

// Header name must match server-side
const STREAM_ID_HEADER = 'X-Stream-Id';

/**
 * Store a streamId for a chat instance
 */
export const setActiveStreamId = ({
  chatId,
  streamId,
}: {
  chatId: string;
  streamId: string;
}): void => {
  activeStreams.set(chatId, streamId);
};

/**
 * Get the active streamId for a chat instance
 */
export const getActiveStreamId = ({
  chatId,
}: {
  chatId: string;
}): string | undefined => {
  return activeStreams.get(chatId);
};

/**
 * Clear the streamId for a chat instance (call when stream completes)
 */
export const clearActiveStreamId = ({ chatId }: { chatId: string }): void => {
  activeStreams.delete(chatId);
};

/**
 * Abort an active stream by calling the server-side abort endpoint
 * Returns true if abort was requested, false if no active stream
 */
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

export const abortActiveStream = async ({
  chatId,
  /**
   * The conversation this chat is streaming, when known. Used ONLY as a fallback: if the
   * activeStreams map has no entry — which is the norm before the response headers land — we
   * still have a name for the stream, and Stop must not silently no-op. See
   * abortActiveStreamByConversation.
   */
  conversationId,
}: {
  chatId: string;
  conversationId?: string | null;
}): Promise<AbortResult> => {
  const streamId = activeStreams.get(chatId);

  if (!streamId) {
    if (conversationId) {
      return abortActiveStreamByConversation({ conversationId });
    }
    return { aborted: false, code: 'not_found', reason: 'No active stream for this chat' };
  }

  try {
    const response = await fetchWithAuth('/api/ai/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Send the conversation ALONGSIDE the streamId, not instead of it. The server prefers the
      // precise name, but a streamId can fail to resolve — a stream started by a worker running the
      // previous image has no `stream_id` on its row at all. Without a second name to fall back to,
      // that Stop is reported as "nothing in flight" and the client stays silent by design, while
      // the generation runs on and bills. Exactly the rolling-deploy window this design claims to
      // turn into a loud, honest warning.
      body: JSON.stringify({ streamId, conversationId: conversationId ?? undefined }),
    });

    const result = await parseAbortResult(response);

    // Forget the stream only once it is settled — stopped, or already gone. On 'unconfirmed' the
    // generation may still be running, so the streamId is the name a retry needs; and on a
    // transport error (401/429/500) we never learned anything at all. Keep it in both cases.
    if (result.code === 'aborted' || result.code === 'not_found') {
      activeStreams.delete(chatId);
    }

    return result;
  } catch (error) {
    // Network error - keep streamId for retry
    console.error('Failed to abort stream:', error);
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
  getChatId,
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
   * Baking `chatId` into this closure therefore froze it at whatever conversation the surface
   * happened to start with. After a single conversation switch the map was WRITTEN under the
   * old id and READ under the new one: `abortActiveStream({chatId})` was a guaranteed miss,
   * the local fetch stopped, and the server kept generating and kept billing. Same for
   * `channelId` after an agent switch: the wrong channel got marked as consuming, so the tab
   * failed to recognise its OWN stream on the socket, joined its own multicast, and rendered
   * the reply twice.
   *
   * The server already compensates for this freeze on the URL side (see the note in
   * /api/ai/global/[id]/messages — the id segment is likewise baked in and never updates).
   * Nothing had propagated that lesson to the tracking keys.
   */
  getChatId: () => string | null;
  getChannelId: () => string | undefined;
}): typeof fetch => {
  return async (url, options) => {
    const chatId = getChatId();
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

    // Extract streamId from response headers (for global assistant route)
    const streamId = response.headers.get(STREAM_ID_HEADER);
    if (streamId && chatId) {
      setActiveStreamId({ chatId, streamId });
    }

    if (!channelId) return response;
    if (!response.ok) {
      unmarkChannelConsuming(channelId);
      return response;
    }

    const consumedChannelId = channelId;
    return withBodyCompletion(response, () => unmarkChannelConsuming(consumedChannelId));
  };
};

