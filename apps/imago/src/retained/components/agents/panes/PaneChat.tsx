 'use client';
import { useEffect } from 'react';
import { useAgentSurfaceStore } from '@/retained/stores/agents/useAgentSurfaceStore';
import { useResolvedAgent } from '../useResolvedAgent';
import { Button } from '@/retained/components/ui/button';
import { useRetainedChatSelection } from '@/retained-adapters/session-selection';
export default function PaneChat({ sessionId, conversationId, agentPageId, driveId, isReadOnly = false }: {
  sessionId: string; conversationId: string; agentPageId: string | null; driveId: string | null;
  context?: 'page' | 'console'; isReadOnly?: boolean;
}) {
  const { agent } = useResolvedAgent(agentPageId);
  const selectedConversation = useAgentSurfaceStore(state => state.selectedConversationId);
  const select = useRetainedChatSelection(state => state.select);
  useEffect(() => { if (selectedConversation !== conversationId) return; select({ sessionId, conversationId, agentId: agentPageId, driveId, isReadOnly }); },
    [selectedConversation, select, sessionId, conversationId, agentPageId, driveId, isReadOnly]);
  return <div className="flex h-full items-center justify-center p-4"><Button variant="outline"
    onClick={() => select({ sessionId, conversationId, agentId: agentPageId, driveId, isReadOnly })}>
    Open {agent?.title ?? 'Global Assistant'} in chat
  </Button></div>;
}
