import { useCallback, useEffect, useRef } from 'react';
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
 *
 * @param originConversationId The conversation the in-flight/failing request was actually
 * SENT against (each surface's `pendingSendConversationId ?? conversationId`) — not
 * necessarily the conversation currently on screen. The same `useChat` instance survives a
 * conversation switch, so a late failure from conversation A that lands after the user has
 * already switched to B must still be keyed under A, or B shows an error that isn't its own
 * (PR 6 review, CodeRabbit).
 */
export function useChatErrorCause(
  conversationId: string | null,
  error: Error | undefined,
  clearTransportError: () => void,
  originConversationId: string | null,
): UseChatErrorCauseResult {
  const prevErrorRef = useRef<Error | undefined>(undefined);

  useEffect(() => {
    if (!error) {
      // The transport error cleared — a retry or a fresh send superseded it. The stored
      // cause must clear too, or the banner keeps rendering the old failure indefinitely
      // (PR 6 review, Codex): dismiss() was previously the only thing that ever cleared it.
      if (prevErrorRef.current && originConversationId) {
        useChatErrorStore.getState().clearError(originConversationId);
      }
      prevErrorRef.current = undefined;
      return;
    }
    if (error === prevErrorRef.current) return;
    prevErrorRef.current = error;
    if (!originConversationId) return;
    const cause = isAIErrorCause(error.cause) ? error.cause : parseLegacyErrorMessage(error.message);
    useChatErrorStore.getState().setError(originConversationId, cause);
  }, [error, originConversationId]);

  const cause = useChatErrorStore((s) => (conversationId ? (s.byConversationId[conversationId] ?? null) : null));

  const dismiss = useCallback(() => {
    if (conversationId) useChatErrorStore.getState().clearError(conversationId);
    clearTransportError();
  }, [conversationId, clearTransportError]);

  return { cause, dismiss };
}
