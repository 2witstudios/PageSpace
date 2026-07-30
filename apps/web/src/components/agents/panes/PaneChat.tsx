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
  conversationId,
  agentPageId,
}: {
  conversationId: string;
  agentPageId: string | null;
}) {
  // Hook order is safe across the branch: the hook itself branches on a null
  // id (null SWR keys), so it runs unconditionally either way.
  const { agent, isLoading } = useResolvedAgent(agentPageId);

  if (agentPageId === null) {
    return <AssistantSessionChat conversationId={conversationId} context="console" />;
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
