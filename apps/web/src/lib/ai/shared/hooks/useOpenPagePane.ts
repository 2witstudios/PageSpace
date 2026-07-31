'use client';

import { useEffect, useRef } from 'react';
import type { UIMessage } from 'ai';
import { OPEN_PAGE_PANE_TOOL_NAME, type OpenPagePaneOutput } from '@/lib/ai/tools/page-pane-tools';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';

const TOOL_PART_TYPE = `tool-${OPEN_PAGE_PANE_TOOL_NAME}`;

interface OpenPagePaneToolPart {
  type: typeof TOOL_PART_TYPE;
  toolCallId: string;
  state?: string;
  output?: OpenPagePaneOutput;
}

/**
 * Reacts to a completed `open_page_pane` tool call by opening/focusing the
 * page in THIS session's pane grid. Unlike `ask_user`, this tool's `execute`
 * always resolves server-side (see `page-pane-tools.ts`'s doc for why), so
 * there is no turn to unblock and no `addToolResult` round-trip — this hook
 * is a pure reaction to the tool call's result already streaming down as
 * part of the assistant message, exactly like any other rendered tool
 * result. A per-mount seen-set is still needed so a rerender never reopens
 * (or resplits) the pane for a call already handled.
 */
export function useOpenPagePane({
  sessionId,
  messages,
}: {
  /** Null for a plain, session-less conversation — there is no pane grid to open into, so the hook no-ops. */
  sessionId: string | null;
  messages: UIMessage[];
}) {
  const handledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!sessionId) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;

    for (const part of last.parts ?? []) {
      if (part.type !== TOOL_PART_TYPE) continue;
      const toolPart = part as unknown as OpenPagePaneToolPart;
      if (toolPart.state !== 'output-available' || !toolPart.output?.opened) continue;
      if (handledRef.current.has(toolPart.toolCallId)) continue;
      handledRef.current.add(toolPart.toolCallId);

      useAgentWorkspaceStore.getState().openPage(sessionId, {
        kind: 'page',
        name: toolPart.output.title ?? 'Page',
        targetId: toolPart.output.pageId,
        agentPageId: null,
      });
    }
  }, [sessionId, messages]);
}
