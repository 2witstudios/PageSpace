'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useStreamingRegistration } from '@/lib/ai/shared';

export interface SideQuestionRequest {
  requestId: string;
  controller: AbortController;
  body: { conversationId: string; question: string };
}

export interface SideQuestionState {
  requestId: string;
  question: string;
  text: string;
  loading: boolean;
  error: string | null;
}

export function createSideQuestionRequest(conversationId: string, question: string): SideQuestionRequest {
  return { requestId: crypto.randomUUID(), controller: new AbortController(), body: { conversationId, question } };
}

export function abortSideQuestion(controller: AbortController | null): void {
  controller?.abort();
}

/**
 * One detached side-question card, owned by this hook and nothing else.
 *
 * The registration below is deliberately NOT redundant with the central
 * `DerivedStreamingRegistrations`: that registrar derives from the primary
 * pending-streams store, which this detached path never touches (that is the
 * feature — dismissing the card cannot abort the main stream). The side
 * question is a stream no central derivation can see, so the hook that owns
 * its whole lifecycle registers it here, keyed by its own request id.
 */
export function useSideQuestion(conversationId: string) {
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<SideQuestionState | null>(null);

  useStreamingRegistration(
    state ? `btw-${state.requestId}` : 'btw-idle',
    Boolean(state?.loading),
    state ? { conversationId, componentName: 'useSideQuestion' } : undefined,
  );

  // Leaving the surface (unmount, or the conversation switching underneath us)
  // must stop consuming the response — and abort propagates through the
  // request signal to cancel the server stream too.
  useEffect(() => {
    return () => abortSideQuestion(controller.current);
  }, [conversationId]);

  const dismiss = useCallback(() => {
    abortSideQuestion(controller.current);
    controller.current = null;
    setState(null);
  }, []);

  const ask = useCallback(async (question: string) => {
    dismiss();
    const request = createSideQuestionRequest(conversationId, question);
    controller.current = request.controller;
    // Every state update below checks that this request is still the active
    // one: ChatInput allows a second /btw while the first is streaming, and a
    // queued decoder chunk or completion from the first must not append into
    // (or clear the loading state of) the replacement card.
    const isCurrent = () => controller.current === request.controller;
    setState({ requestId: request.requestId, question, text: '', loading: true, error: null });
    try {
      // fetchWithAuth (not raw fetch) so the session CSRF token is injected —
      // the route requires CSRF for POST and a bare request would always 403.
      const response = await fetchWithAuth('/api/ai/btw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Btw-Request-Id': request.requestId },
        body: JSON.stringify(request.body),
        signal: request.controller.signal,
      });
      if (!response.ok || !response.body) throw new Error('Side question failed');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!isCurrent()) return;
        setState((current) => (current && current.requestId === request.requestId ? { ...current, text: current.text + chunk } : current));
      }
      if (!isCurrent()) return;
      const tail = decoder.decode();
      setState((current) => (current && current.requestId === request.requestId ? { ...current, text: current.text + tail, loading: false } : current));
    } catch (error) {
      if (request.controller.signal.aborted || !isCurrent()) return;
      setState((current) =>
        current && current.requestId === request.requestId
          ? { ...current, loading: false, error: error instanceof Error ? error.message : 'Side question failed' }
          : current,
      );
    }
  }, [conversationId, dismiss]);

  return { state, ask, dismiss };
}
