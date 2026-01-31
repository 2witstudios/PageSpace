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

/**
 * Create a fetch wrapper that tracks streamId from response headers
 * Use this with DefaultChatTransport
 */
export const createStreamTrackingFetch = ({
  chatId,
}: {
  chatId: string;
}): typeof fetch => {
  return async (url, options) => {
    const urlString = url instanceof Request ? url.url : url.toString();
    const response = await fetchWithAuth(urlString, options);

    // Extract streamId from response headers (for global assistant route)
    const streamId = response.headers.get(STREAM_ID_HEADER);
    if (streamId) {
      setActiveStreamId({ chatId, streamId });
    }

    return response;
  };
};

