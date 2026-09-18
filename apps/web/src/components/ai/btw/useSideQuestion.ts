'use client';

import { useCallback, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

export interface SideQuestionRequest {
  requestId: string;
  controller: AbortController;
  body: { conversationId: string; question: string };
}

export function createSideQuestionRequest(conversationId: string, question: string): SideQuestionRequest {
  return { requestId: crypto.randomUUID(), controller: new AbortController(), body: { conversationId, question } };
}

export function abortSideQuestion(controller: AbortController | null): void {
  controller?.abort();
}

export function useSideQuestion(conversationId: string) {
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ question: string; text: string; loading: boolean; error: string | null } | null>(null);
  const dismiss = useCallback(() => { abortSideQuestion(controller.current); controller.current = null; setState(null); }, []);
  const ask = useCallback(async (question: string) => {
    dismiss();
    const request = createSideQuestionRequest(conversationId, question);
    controller.current = request.controller;
    setState({ question, text: '', loading: true, error: null });
    try {
      // fetchWithAuth (not raw fetch) so the session CSRF token is injected —
      // the route requires CSRF for POST and a bare request would always 403.
      const response = await fetchWithAuth('/api/ai/btw', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Btw-Request-Id': request.requestId }, body: JSON.stringify(request.body), signal: request.controller.signal });
      if (!response.ok || !response.body) throw new Error('Side question failed');
      const reader = response.body.getReader(); const decoder = new TextDecoder();
      while (true) { const { done, value } = await reader.read(); if (done) break; setState((current) => current ? { ...current, text: current.text + decoder.decode(value, { stream: true }) } : current); }
      const tail = decoder.decode();
      setState((current) => current ? { ...current, text: current.text + tail, loading: false } : current);
    } catch (error) { if (!request.controller.signal.aborted) setState((current) => current ? { ...current, loading: false, error: error instanceof Error ? error.message : 'Side question failed' } : current); }
  }, [conversationId, dismiss]);
  return { state, ask, dismiss };
}
