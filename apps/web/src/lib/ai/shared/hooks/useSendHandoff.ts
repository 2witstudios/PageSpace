import { useCallback, useEffect, useRef } from 'react';
import { useEditingStore } from '@/stores/useEditingStore';

/**
 * Manages deterministic handoff between pending send and streaming state.
 * Replaces the non-deterministic 500ms setTimeout pattern with effect-based coordination.
 *
 * The hook:
 * 1. Registers pendingSend when wrapSend() is called
 * 2. Watches for isStreaming to become true
 * 3. Clears pendingSend when streaming takes over (deterministic)
 *
 * This ensures UI refresh protection is continuous from send button click
 * through streaming completion, without relying on arbitrary timeouts.
 */
export function useSendHandoff(
  conversationId: string | null,
  isStreaming: boolean
): {
  wrapSend: <T>(sendFn: () => T) => T | undefined;
} {
  const hasPendingSendRef = useRef(false);

  // Effect-based handoff: clear pendingSend when streaming takes over
  useEffect(() => {
    if (isStreaming && hasPendingSendRef.current && conversationId) {
      hasPendingSendRef.current = false;
      useEditingStore.getState().endPendingSend(conversationId);
    }
  }, [isStreaming, conversationId]);

  // Cleanup on unmount
  useEffect(() => {
    const savedConversationId = conversationId;
    return () => {
      if (hasPendingSendRef.current && savedConversationId) {
        useEditingStore.getState().endPendingSend(savedConversationId);
        hasPendingSendRef.current = false;
      }
    };
  }, [conversationId]);

  const wrapSend = useCallback(<T>(sendFn: () => T): T | undefined => {
    if (!conversationId) return undefined;

    hasPendingSendRef.current = true;
    useEditingStore.getState().startPendingSend(conversationId);

    return sendFn();
  }, [conversationId]);

  return { wrapSend };
}
