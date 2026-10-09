'use client';

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import AssistantSessionChat from '@/retained/components/agents/chat/AssistantSessionChat';
import { useRetainedChatSelection } from './session-selection';
import { usePermissions } from '@/retained/hooks/usePermissions';
import SessionChat from '@/retained/components/agents/chat/SessionChat';
import type { AgentInfo } from '@/retained/types/agent';
import { RetainedSurface } from './retained-provider';
import { useApiClient } from '@/api/swr-provider';
import { createConversation } from '@/ui/chat/chat-api/chat-api';
import { dispatch, transactions } from '@/ui/store/transactions';
import { renderLoadingState, renderErrorState } from '@/ui/frame/edge-state/edge-state.render';

export function RetainedChat({ agentId, name, conversationId, resolving }: {
  agentId: string | null; name: string; conversationId: string | null; resolving: boolean;
}) {
  const selection = useRetainedChatSelection(state => state.selection);
  const selectedAgentId = selection ? selection.agentId : agentId;
  const { permissions } = usePermissions(selectedAgentId);
  const client = useApiClient();
  const { data: page, error, mutate } = useSWR<AgentInfo>(selectedAgentId ? `/api/pages/${encodeURIComponent(selectedAgentId)}` : null);
  const creating = useRef(false);
  const [creationError, setCreationError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(agentId);
  latest.current = agentId;
  useEffect(() => {
    if (selection || !agentId || conversationId || resolving || creating.current || !page) return;
    creating.current = true;
    setCreationError(false);
    void createConversation(client, agentId).then(id => {
      if (latest.current === agentId) dispatch(transactions.openConversation, id);
    }).catch(() => setCreationError(true)).finally(() => { creating.current = false; if (latest.current !== agentId) setAttempt(value => value + 1); });
  }, [selection, agentId, client, conversationId, resolving, page, attempt]);
  if (error || creationError) return renderErrorState({ title: 'Could not open this chat', retry: () => { void mutate(); setAttempt(value => value + 1); } });
  if (selection?.agentId === null) return <RetainedSurface><AssistantSessionChat sessionId={selection.sessionId}
    conversationId={selection.conversationId} driveId={selection.driveId} context="page" isReadOnly={selection.isReadOnly} /></RetainedSurface>;
  const shownId = selection?.conversationId ?? conversationId;
  if (!page || !shownId) return renderLoadingState('Opening chat…');
  return <RetainedSurface><SessionChat agent={{ ...page, id: selectedAgentId ?? page.id, title: selection ? page.title : name, driveName: '' }} conversationId={shownId} sessionId={selection?.sessionId} context="page" isReadOnly={selection?.isReadOnly || permissions?.canEdit !== true} /></RetainedSurface>;
}
