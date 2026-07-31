'use client';

/**
 * One chat pane: a conversation rendered inside its session's grid.
 *
 * Exists because `SessionChat` takes a resolved `AgentInfo` and hooks cannot
 * run inside a render-prop map — each pane resolves its OWN agent identity
 * here, which is also what lets one grid hold conversations with different
 * agents side by side.
 *
 * A null `agentPageId` is the GLOBAL ASSISTANT: no page to resolve, so no
 * resolution step — `AssistantSessionChat` reads its identity from the
 * assistant settings store and rides the global chat pipeline.
 */

import { Loader2 } from 'lucide-react';
import AssistantSessionChat from '../chat/AssistantSessionChat';
import SessionChat from '../chat/SessionChat';
import { useResolvedAgent } from '../useResolvedAgent';

export default function PaneChat({
  sessionId,
  conversationId,
  agentPageId,
  driveId,
  context = 'console',
  isReadOnly = false,
}: {
  /** This pane's session — threaded through so the chat surface can react to `open_page_pane` tool calls by opening a pane in THIS session's grid. */
  sessionId: string;
  conversationId: string;
  agentPageId: string | null;
  /** This pane's session's own drive — `null` for a global-assistant session. Only the assistant branch needs it (an agent already carries its own `driveId`). */
  driveId: string | null;
  /** Which message renderer to use — the page grid hosts the full one. */
  context?: 'page' | 'console';
  isReadOnly?: boolean;
}) {
  // Hook order is safe across the branch: the hook itself branches on a null
  // id (null SWR keys), so it runs unconditionally either way.
  const { agent, isLoading } = useResolvedAgent(agentPageId);

  if (agentPageId === null) {
    return (
      <AssistantSessionChat
        sessionId={sessionId}
        conversationId={conversationId}
        driveId={driveId}
        context={context}
        isReadOnly={isReadOnly}
      />
    );
  }

  if (isLoading || !agent) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <SessionChat
      sessionId={sessionId}
      agent={agent}
      conversationId={conversationId}
      context={context}
      isReadOnly={isReadOnly}
    />
  );
}
