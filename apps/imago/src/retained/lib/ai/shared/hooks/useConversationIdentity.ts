/**
 * Shared wiring around conversationIdentityReducer. Owns the useReducer
 * instance and the RESOLVE_STARTED/RESOLVED/RESOLVE_FAILED dispatch-on-mount
 * cycle so every chat surface (AiChatView, GlobalAssistantView,
 * GlobalChatContext) calls this one hook with its own `resolve` function
 * instead of each hand-rolling the same reducer + effect boilerplate.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  conversationIdentityReducer,
  canSend as canSendState,
  type ConversationIdentityState,
} from '../conversation-identity';

export interface ConversationIdentityResolveResult {
  conversationId: string;
  /**
   * Whether this id refers to a conversation that exists server-side.
   *
   * The surfaces used to answer this by string-matching a sentinel id
   * (`${pageId}-default`), which broke the moment the server accepted that
   * sentinel and wrote a real row under it: the messages persisted, and the
   * client then refused to load them because the id still "looked like" a
   * placeholder. Gate on the fact, not the shape of the string.
   *
   * Defaults to true — a surface that only ever resolves to conversations it
   * fetched from the server never needs to think about this.
   */
  isPersisted?: boolean;
}

export interface UseConversationIdentityOptions {
  /** Determines which conversation this surface should show on mount (e.g. "most recent conversation for this page"). Rejects on failure. */
  resolve: () => Promise<ConversationIdentityResolveResult>;
}

export interface UseConversationIdentityResult {
  state: ConversationIdentityState;
  canSend: boolean;
  /** False when the current id has no server-side conversation yet (a freshly minted one). */
  isPersisted: boolean;
  /** Adopt a known id immediately (new conversation, or one picked from history) — synchronous, no dependency on any fetch resolving. */
  setIdentity: (conversationId: string, options?: { isPersisted?: boolean }) => void;
  /**
   * Declare whether the current id exists server-side. Set true when a send creates
   * the row; set false again if the server turns out not to have it (a failed send —
   * the credit gate runs BEFORE the conversation is persisted — or a conversation
   * deleted elsewhere), so the surface falls back to "fresh chat" instead of showing
   * a load-failure banner for a conversation that was never created.
   */
  setPersisted: (isPersisted: boolean) => void;
  /** Re-run resolve() after an error. */
  retry: () => void;
}

export function useConversationIdentity({
  resolve,
}: UseConversationIdentityOptions): UseConversationIdentityResult {
  const [state, dispatch] = useReducer(conversationIdentityReducer, { status: 'idle' as const });
  const [isPersisted, setIsPersisted] = useState(true);

  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // The reducer already drops a stale RESOLVED ("a stale resolve must never clobber an
  // identity the user has already set more recently"), but `isPersisted` lives in React
  // state OUTSIDE the reducer, so it needs the same protection explicitly. Without it, a
  // resolve still in flight when the user picks a conversation from History lands
  // afterwards and flips isPersisted to `false` — the loaders then SKIP that real
  // conversation and the user stares at an empty chat.
  const resolveGenerationRef = useRef(0);

  const runResolve = useCallback((startAction: { type: 'RESOLVE_STARTED' } | { type: 'RETRY' }) => {
    const generation = (resolveGenerationRef.current += 1);
    dispatch(startAction);
    resolveRef.current().then(
      (result) => {
        if (!isMountedRef.current) return;
        if (resolveGenerationRef.current !== generation) return; // superseded
        setIsPersisted(result.isPersisted ?? true);
        dispatch({ type: 'RESOLVED', conversationId: result.conversationId });
      },
      (error) => {
        if (!isMountedRef.current) return;
        if (resolveGenerationRef.current !== generation) return; // superseded
        const message = error instanceof Error ? error.message : 'Failed to resolve conversation';
        dispatch({ type: 'RESOLVE_FAILED', message });
      }
    );
  }, []);

  useEffect(() => {
    runResolve({ type: 'RESOLVE_STARTED' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setIdentity = useCallback((conversationId: string, options?: { isPersisted?: boolean }) => {
    // Invalidate any resolve still in flight — the user has chosen, and its answer is now
    // stale for BOTH the id (the reducer's job) and isPersisted (ours).
    resolveGenerationRef.current += 1;
    setIsPersisted(options?.isPersisted ?? true);
    dispatch({ type: 'IDENTITY_SET', conversationId });
  }, []);

  const setPersisted = useCallback((next: boolean) => {
    setIsPersisted(next);
  }, []);

  const retry = useCallback(() => {
    runResolve({ type: 'RETRY' });
  }, [runResolve]);

  return { state, canSend: canSendState(state), isPersisted, setIdentity, setPersisted, retry };
}
