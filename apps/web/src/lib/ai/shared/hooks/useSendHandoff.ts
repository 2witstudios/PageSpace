import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useEditingStore } from '@/stores/useEditingStore';
import { getAIErrorMessage } from '@/lib/ai/shared/error-messages';
import { isThenable } from '@/lib/ai/streams/isThenable';

/**
 * Manages deterministic handoff between pending send and streaming state.
 *
 * The hook:
 * 1. Registers pendingSend when wrapSend() is called
 * 2. Watches for streaming to start OR error to occur
 * 3. Clears pendingSend when streaming takes over or on error (deterministic)
 * 4. Includes a safety timeout (15s) to auto-clear orphaned pendingSend
 *
 * This ensures UI refresh protection is continuous from send button click
 * through streaming completion, without relying on arbitrary timeouts.
 */
export function useSendHandoff(
  conversationId: string | null,
  status: 'ready' | 'submitted' | 'streaming' | 'error'
): {
  wrapSend: <T>(sendFn: () => T) => T | undefined;
} {
  const hasPendingSendRef = useRef(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isStreaming = status === 'submitted' || status === 'streaming';

  // Effect-based handoff: clear pendingSend when streaming takes over OR on error
  useEffect(() => {
    if (hasPendingSendRef.current && conversationId) {
      if (isStreaming) {
        // Happy path: streaming started, clear pendingSend
        hasPendingSendRef.current = false;
        useEditingStore.getState().endPendingSend(conversationId);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      } else if (status === 'error') {
        // Error path: API call failed, clear pendingSend to unblock
        hasPendingSendRef.current = false;
        useEditingStore.getState().endPendingSend(conversationId);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      }
    }
  }, [isStreaming, status, conversationId]);

  // Cleanup on unmount or conversation change
  useEffect(() => {
    const savedConversationId = conversationId;
    return () => {
      if (hasPendingSendRef.current && savedConversationId) {
        useEditingStore.getState().endPendingSend(savedConversationId);
        hasPendingSendRef.current = false;
      }
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [conversationId]);

  const wrapSend = useCallback(<T>(sendFn: () => T): T | undefined => {
    if (!conversationId) return undefined;

    hasPendingSendRef.current = true;
    useEditingStore.getState().startPendingSend(conversationId);

    // Safety timeout: clear pendingSend if streaming never starts
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (hasPendingSendRef.current && conversationId) {
        console.warn('[useSendHandoff] Safety timeout: clearing orphaned pendingSend');
        hasPendingSendRef.current = false;
        useEditingStore.getState().endPendingSend(conversationId);
      }
    }, 15000);

    // Shared by both failure paths: sendFn can throw synchronously (e.g. a guard
    // clause before any await) or return a promise that rejects later (e.g. an
    // awaited pre-send fetch) — either way pendingSend must clear immediately and
    // the caller sees an error, rather than sitting registered until the 15s
    // safety timeout with no visible feedback.
    const settleOnFailure = (error: unknown) => {
      hasPendingSendRef.current = false;
      useEditingStore.getState().endPendingSend(conversationId);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      toast.error(getAIErrorMessage(error instanceof Error ? error.message : String(error)));
    };

    try {
      const result = sendFn();
      if (isThenable(result)) {
        Promise.resolve(result).catch(settleOnFailure);
      }
      return result;
    } catch (error) {
      settleOnFailure(error);
      throw error;
    }
  }, [conversationId]);

  return { wrapSend };
}
