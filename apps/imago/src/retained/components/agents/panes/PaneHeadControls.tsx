'use client';

import { SquareTerminal } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useAgentPaneRequestStore } from '@/retained/stores/agent-workspace/useAgentPaneRequestStore';

/** "model · n tools" for the chat pane head; null when the agent's config has not loaded. */
export function agentModelToolsLabel(
  config: { aiModel?: string; enabledTools: string[] } | null | undefined,
): string | null {
  if (!config?.aiModel) return null;
  const count = config.enabledTools.length;
  return `${config.aiModel} · ${count} ${count === 1 ? 'tool' : 'tools'}`;
}

/** The board's "Open shell" button, shown in the chat pane head while no shell pane is open. */
export function OpenShellButton({ onOpen }: { onOpen(): void }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <SquareTerminal className="size-3.5" aria-hidden="true" />
      Open shell
    </button>
  );
}

/**
 * Runs `handler` once per new request for `sessionId` made through the request store
 * (the counter present at mount is the baseline, so old requests never replay).
 */
export function usePaneRequest(
  kind: 'addPane' | 'openShell',
  sessionId: string,
  handler: () => void,
): void {
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
