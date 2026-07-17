import { useCallback, useEffect } from 'react';
import { useChatErrorStore } from '@/stores/useChatErrorStore';
import { parseLegacyErrorMessage } from '@/lib/ai/shared/parseLegacyErrorMessage';
import { isAIErrorCause, type AIErrorCause } from '@/lib/ai/shared/aiErrorCause';

export interface UseChatErrorCauseResult {
  cause: AIErrorCause | null;
  dismiss: () => void;
}

/**
 * Syncs a useChat instance's `error` into the per-conversation error store
 * (epic leaf 6.5) and reads it back reactively — ChatErrorBanner never
 * touches `error.message` directly again. `error.cause` is used when present
 * (the real path: `createStreamTrackingFetch` attaches a typed cause on
 * every non-ok response); `parseLegacyErrorMessage` is the one surviving
 * fallback for whatever still reaches this hook as a bare message string.
 */
export function useChatErrorCause(
  conversationId: string | null,
  error: Error | undefined,
  clearTransportError: () => void,
): UseChatErrorCauseResult {
  useEffect(() => {
    if (!conversationId || !error) return;
    const cause = isAIErrorCause(error.cause) ? error.cause : parseLegacyErrorMessage(error.message);
    useChatErrorStore.getState().setError(conversationId, cause);
  }, [conversationId, error]);

  const cause = useChatErrorStore((s) => (conversationId ? (s.byConversationId[conversationId] ?? null) : null));

  const dismiss = useCallback(() => {
    if (conversationId) useChatErrorStore.getState().clearError(conversationId);
    clearTransportError();
  }, [conversationId, clearTransportError]);

  return { cause, dismiss };
}
