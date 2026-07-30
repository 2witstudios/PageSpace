'use client';

/**
 * One chat pane: a conversation rendered inside its session's grid.
 *
 * Exists because `SessionChat` takes a resolved `AgentInfo` and hooks cannot
 * run inside a render-prop map — each pane resolves its OWN agent identity
 * here, which is also what lets one grid hold conversations with different
 * agents side by side.
 *
 * A null `agentPageId` is a global-assistant conversation; its identity path
 * does not exist yet (tracked on the epic, Phase R2), so it renders a plain
 * notice rather than a broken chat — the pane picker does not offer it until
 * that path lands (`canPickAssistant` defaults false).
 */

import { Loader2 } from 'lucide-react';
import SessionChat from '../chat/SessionChat';
import { useResolvedAgent } from '../useResolvedAgent';

export default function PaneChat({
  conversationId,
  agentPageId,
}: {
  conversationId: string;
  agentPageId: string | null;
}) {
  const { agent, isLoading } = useResolvedAgent(agentPageId);

  if (agentPageId === null) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        Global assistant conversations are not available in panes yet.
      </div>
    );
  }

  if (isLoading || !agent) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <SessionChat agent={agent} conversationId={conversationId} context="console" />;
}
