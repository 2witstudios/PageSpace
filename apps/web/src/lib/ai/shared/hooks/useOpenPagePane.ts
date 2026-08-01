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
 *
 * `conversationId` is passed to `openPage` as `excludeTargetId`: this
 * conversation's OWN pane must never be the one the tool call replaces — a
 * pane grid with only this one chat pane open would otherwise satisfy
 * `focusOrAssignScope`'s "replaceable" check and evict the very conversation
 * that just asked to show its work, which is backwards. The store instead
 * splits a new pane beside it.
 */
export function useOpenPagePane({
  sessionId,
  conversationId,
  messages,
}: {
  /** Null for a plain, session-less conversation — there is no pane grid to open into, so the hook no-ops. */
  sessionId: string | null;
  /** This conversation's own id — excluded from replacement (see doc above). */
  conversationId: string;
  messages: UIMessage[];
}) {
  const handledRef = useRef<Set<string>>(new Set());
  // Whether we've ever inspected a REAL last-assistant-message yet. `false`
  // on the very first sighting means every already-`output-available` call
  // found there is HISTORY (loaded on mount, a remount, or a reopened
  // conversation) rather than something that just streamed in — reacting to
  // it would re-open/re-focus a pane the user may have since closed or
  // repurposed, on every remount, forever. Those are marked handled without
  // being acted on; only a call that becomes `output-available` on a LATER
  // run (a genuinely new stream) is acted on.
  const hasSeededRef = useRef(false);

  useEffect(() => {
    if (!sessionId) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;

    const isFirstSighting = !hasSeededRef.current;
    hasSeededRef.current = true;

    for (const part of last.parts ?? []) {
      if (part.type !== TOOL_PART_TYPE) continue;
      const toolPart = part as unknown as OpenPagePaneToolPart;
      if (toolPart.state !== 'output-available' || !toolPart.output?.opened) continue;
      if (handledRef.current.has(toolPart.toolCallId)) continue;
      handledRef.current.add(toolPart.toolCallId);
      if (isFirstSighting) continue;

      useAgentWorkspaceStore.getState().openPage(
        sessionId,
        {
          kind: 'page',
          name: toolPart.output.title ?? 'Page',
          targetId: toolPart.output.pageId,
          agentPageId: null,
        },
        { excludeTargetId: conversationId },
      );
    }
  }, [sessionId, conversationId, messages]);
}
