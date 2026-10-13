'use client';

import { useEffect, useRef } from 'react';
import type { UIMessage } from 'ai';
import { OPEN_PAGE_PANE_TOOL_NAME, type OpenPagePaneOutput } from '@/retained/lib/ai/tools/page-pane-tools';
import { usePageNavigation } from '@/retained/hooks/usePageNavigation';

const TOOL_PART_TYPE = `tool-${OPEN_PAGE_PANE_TOOL_NAME}`;

interface OpenPagePaneToolPart {
  type: typeof TOOL_PART_TYPE;
  toolCallId: string;
  state?: string;
  output?: OpenPagePaneOutput;
}

/** React to newly completed page tools by selecting Imago's native object slot.
 * Resolve the page's authorized actual drive while the shell/chat stays mounted.
 * Completed history is seeded into the seen-set and never replayed on selection.
 */
export function useOpenPagePane({
  sessionId,
  conversationId,
  messages,
}: {
  /** Optional workspace binding; ordinary conversations also navigate natively. */
  sessionId: string | null;
  /** Resets history deduplication when the selected conversation changes. */
  conversationId: string;
  messages: UIMessage[];
}) {
  const { navigateToPage } = usePageNavigation();
  const handledRef = useRef<Set<string>>(new Set());
  // Whether we've ever inspected a REAL last-assistant-message yet FOR THIS
  // CONVERSATION. `false` on the very first sighting means every already-
  // `output-available` call found there is HISTORY (loaded on mount, a
  // remount, a reopened conversation, or — see `seenConversationIdRef` below
  // — a DIFFERENT conversation the pane bar just switched this same pane to)
  // rather than something that just streamed in; reacting to it would
  // re-open/re-focus a pane the user may have since closed or repurposed.
  // Those are marked handled without being acted on; only a call that
  // becomes `output-available` on a LATER run (a genuinely new stream) is
  // acted on.
  const hasSeededRef = useRef(false);
  // `SessionChat`/`AssistantSessionChat` are never keyed by conversationId
  // (`AgentPanes`'s pane-bar agent switcher rebinds the SAME pane's scope to
  // a different conversation in place — `handleSwitchAgent` → `assignPane`),
  // so this hook's refs can outlive the conversation they were seeded for.
  // Without this reset, switching a pane from conversation A to a FRESH
  // mount-free conversation B whose own history already ends in a completed
  // `open_page_pane` call would read B's history through A's now-stale
  // `hasSeededRef === true` and wrongly treat it as new.
  const seenConversationIdRef = useRef<string | null>(null);

  useEffect(() => {

    if (seenConversationIdRef.current !== conversationId) {
      seenConversationIdRef.current = conversationId;
      handledRef.current = new Set();
      hasSeededRef.current = false;
    }
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

      void navigateToPage(toolPart.output.pageId);
    }
  }, [sessionId, conversationId, messages, navigateToPage]);
}
