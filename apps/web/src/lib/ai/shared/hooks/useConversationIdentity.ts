/**
 * Shared wiring around conversationIdentityReducer. Owns the useReducer
 * instance and the RESOLVE_STARTED/RESOLVED/RESOLVE_FAILED dispatch-on-mount
 * cycle so every chat surface (AiChatView, GlobalAssistantView,
 * GlobalChatContext) calls this one hook with its own `resolve` function
 * instead of each hand-rolling the same reducer + effect boilerplate.
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  conversationIdentityReducer,
  canSend as canSendState,
  type ConversationIdentityState,
} from '../conversation-identity';

export interface ConversationIdentityResolveResult {
  conversationId: string;
}

export interface UseConversationIdentityOptions {
  /** Determines which conversation this surface should show on mount (e.g. "most recent conversation for this page"). Rejects on failure. */
  resolve: () => Promise<ConversationIdentityResolveResult>;
}

export interface UseConversationIdentityResult {
  state: ConversationIdentityState;
  canSend: boolean;
  /** Adopt a known id immediately (new conversation, or one picked from history) — synchronous, no dependency on any fetch resolving. */
  setIdentity: (conversationId: string) => void;
  /** Re-run resolve() after an error. */
  retry: () => void;
}

export function useConversationIdentity({
  resolve,
}: UseConversationIdentityOptions): UseConversationIdentityResult {
  const [state, dispatch] = useReducer(conversationIdentityReducer, { status: 'idle' as const });

  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const runResolve = useCallback((startAction: { type: 'RESOLVE_STARTED' } | { type: 'RETRY' }) => {
    dispatch(startAction);
    resolveRef.current().then(
      (result) => {
        if (isMountedRef.current) dispatch({ type: 'RESOLVED', conversationId: result.conversationId });
      },
      (error) => {
        if (!isMountedRef.current) return;
        const message = error instanceof Error ? error.message : 'Failed to resolve conversation';
        dispatch({ type: 'RESOLVE_FAILED', message });
      }
    );
  }, []);

  useEffect(() => {
    runResolve({ type: 'RESOLVE_STARTED' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setIdentity = useCallback((conversationId: string) => {
    dispatch({ type: 'IDENTITY_SET', conversationId });
  }, []);

  const retry = useCallback(() => {
    runResolve({ type: 'RETRY' });
  }, [runResolve]);

  return { state, canSend: canSendState(state), setIdentity, retry };
}
