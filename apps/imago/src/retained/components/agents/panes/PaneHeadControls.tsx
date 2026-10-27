'use client';

import { useEffect, useRef } from 'react';
import { useAgentPaneRequestStore } from '@/retained/stores/agent-workspace/useAgentPaneRequestStore';

/**
 * Runs `handler` once per new request for `sessionId` made through the request store
 * (the counter present at mount is the baseline, so old requests never replay).
 */
export function usePaneRequest(kind: 'addPane', sessionId: string, handler: () => void): void {
  const count = useAgentPaneRequestStore((state) => state[kind][sessionId] ?? 0);
  const seen = useRef(count);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (count === seen.current) return;
    seen.current = count;
    latest.current();
  }, [count]);
}
