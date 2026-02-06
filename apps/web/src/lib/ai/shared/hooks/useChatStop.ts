import { useCallback } from 'react';
import { abortActiveStream } from '@/lib/ai/core/client';

/**
 * Returns a memoized stop function that aborts the server-side stream
 * then stops the client-side fetch via useChat's stop.
 *
 * Uses try/finally to guarantee client-side stop runs even if server abort fails.
 */
export function useChatStop(
  chatId: string | null,
  chatStop: () => void
): () => Promise<void> {
  return useCallback(async () => {
    try {
      if (chatId) {
        await abortActiveStream({ chatId });
      }
    } finally {
      chatStop();
    }
  }, [chatId, chatStop]);
}
