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

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { getBrowserSessionId } from './browser-session-id';
import {
  markChannelConsuming,
  unmarkChannelConsuming,
} from '@/lib/ai/streams/consumingChannels';

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
export const abortActiveStream = async ({
  chatId,
}: {
  chatId: string;
}): Promise<{ aborted: boolean; reason: string }> => {
  const streamId = activeStreams.get(chatId);

  if (!streamId) {
    return { aborted: false, reason: 'No active stream for this chat' };
  }

  try {
    const response = await fetchWithAuth('/api/ai/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamId }),
    });

    const result = await response.json();

    // Only clear streamId when abort succeeded or stream is already gone
    // Keep streamId on 401/429/500 errors so user can retry
    const shouldClear =
      result.aborted === true ||
      (result.reason &&
        (result.reason.includes('not found') ||
          result.reason.includes('already completed')));

    if (shouldClear) {
      activeStreams.delete(chatId);
    }

    return result;
  } catch (error) {
    // Network error - keep streamId for retry
    console.error('Failed to abort stream:', error);
    return { aborted: false, reason: 'Failed to call abort endpoint' };
  }
};

export const abortActiveStreamByMessageId = async ({
  messageId,
}: {
  messageId: string;
}): Promise<{ aborted: boolean; reason: string }> => {
  try {
    const response = await fetchWithAuth('/api/ai/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId }),
    });
    return await response.json();
  } catch {
    return { aborted: false, reason: 'Failed to call abort endpoint' };
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

