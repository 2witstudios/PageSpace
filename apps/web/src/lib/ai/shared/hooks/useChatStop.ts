import { useCallback } from 'react';
import { abortActiveStream } from '@/lib/ai/core/client';

/**
 * Returns a memoized stop function that aborts the server-side stream
 * then stops the client-side fetch via useChat's stop.
 *
 * Uses try/finally to guarantee client-side stop runs even if server abort fails.
 *
 * `conversationId` is what makes this able to stop anything at all in the windows that matter.
 *
 * The `chatId` lookup is a client-side map (`activeStreams`) populated only once the response
 * HEADERS land — and a real agent send spends 0.5-3 seconds before that (auth, rate limit, DB
 * reads, context assembly, connecting to the provider). The same map is also torn down by the
 * surfaces' own conversation-change cleanups, which fire on a mid-stream switch. So on the two
 * paths a user is most likely to take — Stop right after Send, and Stop after switching
 * conversation — the map was EMPTY, the abort was a guaranteed no-op, and this cancelled the
 * local fetch and returned.
 *
 * Cancelling the fetch stops NOTHING. Streams are deliberately server-owned and survive a client
 * disconnect — that is the architecture. So the generation kept running, kept calling write
 * tools, and kept BILLING, while the button flipped back to Send and the user believed it had
 * stopped.
 *
 * The conversationId is the one name the client holds from t=0, and the server can abort by it
 * (the caller's OWN streams only — see abort-conversation-streams.ts). Pass the STREAM's
 * conversation, held from when it started — never the live one — so a mid-stream switch still
 * names the generation that is actually running.
 */
export function useChatStop(
  chatId: string | null,
  chatStop: () => void,
  conversationId?: string | null,
): () => Promise<void> {
  return useCallback(async () => {
    try {
      if (chatId) {
        await abortActiveStream({ chatId, conversationId });
      } else if (conversationId) {
        // No transport key, but we still know which conversation is generating.
        await abortActiveStream({ chatId: conversationId, conversationId });
      }
    } finally {
      chatStop();
    }
  }, [chatId, chatStop, conversationId]);
}
