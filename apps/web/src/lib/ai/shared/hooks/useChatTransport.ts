import { useRef } from 'react';
import { DefaultChatTransport, UIMessage } from 'ai';
import { createStreamTrackingFetch } from '@/lib/ai/core/client';

/**
 * Creates a stable DefaultChatTransport instance that only recreates when
 * the conversation ID changes. Avoids unnecessary useChat state resets
 * caused by new transport identity.
 *
 * Returns null when conversationId is null (no active conversation).
 */
export function useChatTransport(
  conversationId: string | null,
  api: string
): DefaultChatTransport<UIMessage> | null {
  const transportRef = useRef<DefaultChatTransport<UIMessage> | null>(null);
  const trackingIdRef = useRef<string | null>(null);

  if (!conversationId) {
    return null;
  }

  if (trackingIdRef.current !== conversationId || !transportRef.current) {
    transportRef.current = new DefaultChatTransport({
      api,
      fetch: createStreamTrackingFetch({ chatId: conversationId }),
    });
    trackingIdRef.current = conversationId;
  }

  return transportRef.current;
}
