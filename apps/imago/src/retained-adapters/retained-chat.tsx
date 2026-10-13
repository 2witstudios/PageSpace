'use client';

import React, { useRef, useState } from 'react';
import useSWR from 'swr';
import type { FileUIPart } from 'ai';
import { ChatMessagesArea } from '@/retained/components/ai/shared/chat/ChatMessagesArea';
import { ChatInput } from '@/retained/components/ai/chat/input';
import { hasVisionCapability } from '@/retained/lib/ai/core/vision-models';
import { useChatAttachments } from './chat-attachments';
import { useUiState, getUiState } from '@/ui/store/store';
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
import { HomeLine } from '@/retained/components/ai/chat/layouts/HomeLine';
import { HomeSuggestions } from '@/retained/components/ai/chat/layouts/HomeSuggestions';
import { useHomeSignals } from '@/retained/hooks/useHomeSignals';

/** Classic's Home line and suggestions for a new, empty conversation; picking one fills the composer. */
function HomeWelcome() {
  const { line } = useHomeSignals();
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto px-4">
    <HomeLine line={line} />
    <HomeSuggestions suggestions={line.suggestions} onSelect={text => dispatch(transactions.setChatDraft, text)} />
  </div>;
}

export function RetainedChat({ agentId, name, conversationId, resolving, placeholder, aboveComposer, home }: {
  agentId: string | null; name: string; conversationId: string | null; resolving: boolean;
  /** Imago's chat home (section 'chat'): a new, empty conversation greets the user with the Home line. */
  home?: boolean;
  /** The composer's invitation for what Imago answers about (chatContextFor): "Ask about this page…". */
  placeholder?: string;
  /** Imago's spend strip, directly above the composer (IMC-2.4). */
  aboveComposer?: React.ReactNode;
}) {
  const selection = useRetainedChatSelection(state => state.selection);
  const selectedAgentId = selection ? selection.agentId : agentId;
  const { permissions } = usePermissions(selectedAgentId);
  const client = useApiClient();
  const { data: page, error, mutate } = useSWR<AgentInfo>(selectedAgentId ? `/api/pages/${encodeURIComponent(selectedAgentId)}` : null);
  const creating = useRef(false);
  const [creationError, setCreationError] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [firstSend, setFirstSend] = useState<{
    id: string; conversationId: string; text: string; files: FileUIPart[]; attachmentIds: string[];
  } | null>(null);
  const input = useUiState(state => state.resources.chatDraft);
  const { attachments, addFiles, removeFile, getFilesForSend } = useChatAttachments();
  const restoreDraft = (text: string) => {
    if (getUiState().resources.chatDraft === '') dispatch(transactions.setChatDraft, text);
  };
  const latest = useRef(agentId);
  latest.current = agentId;
  const prepareFirstSend = async () => {
    const text = getUiState().resources.chatDraft;
    const files = getFilesForSend();
    if (creating.current || !agentId || !page || permissions?.canEdit !== true || (!text.trim() && !files.length)) return;
    creating.current = true;
    setPreparing(true);
    setCreationError(false);
    const attachmentIds = attachments.filter(item => !item.processing && item.dataUrl).map(item => item.id);
    dispatch(transactions.setChatDraft, '');
    try {
      const id = await createConversation(client, agentId);
      if (latest.current !== agentId || useRetainedChatSelection.getState().selection !== null) {
        restoreDraft(text);
        return;
      }
      setFirstSend({ id, conversationId: id, text, files, attachmentIds });
      dispatch(transactions.openConversation, id);
    } catch {
      restoreDraft(text);
      setCreationError(true);
    } finally {
      creating.current = false;
      setPreparing(false);
    }
  };
  if (error) return renderErrorState({ title: 'Could not open this chat', retry: () => { void mutate(); } });
  if (selection?.agentId === null) return <RetainedSurface><AssistantSessionChat sessionId={selection.sessionId}
    conversationId={selection.conversationId} driveId={selection.driveId} context="page" isReadOnly={selection.isReadOnly} /></RetainedSurface>;
  const shownId = selection?.conversationId ?? conversationId;
  if (!page || (resolving && !selection && !shownId)) return renderLoadingState('Opening chat…');
  if (!shownId) return <RetainedSurface><div className="@container flex h-full min-w-0 min-h-0 flex-col bg-background">
    <div className="min-h-0 min-w-0 flex-1 overflow-hidden flex flex-col">{home
      ? <HomeWelcome />
      : <ChatMessagesArea messages={[]} isLoading={false} isStreaming={false} />}</div>
    {creationError && <p role="alert" className="px-2 text-sm text-destructive">Could not open this chat. Try sending again.</p>}
    <div className="p-2">{aboveComposer}<ChatInput value={input}
      onChange={value => dispatch(transactions.setChatDraft, value)} onSend={() => void prepareFirstSend()}
      disabled={preparing || permissions?.canEdit !== true} isStreaming={false} onStop={() => undefined} hideModelSelector variant="sidebar" showMention
      placeholder={placeholder ?? `Message ${name}...`} hasVision={hasVisionCapability(page.aiModel || '')}
      attachments={attachments} onAddFiles={addFiles} onRemoveFile={removeFile} driveId={page.driveId} crossDrive commandDriveId={page.driveId} /></div>
  </div></RetainedSurface>;
  return <RetainedSurface><SessionChat agent={{ ...page, id: selectedAgentId ?? page.id, title: selection ? page.title : name, driveName: '' }} conversationId={shownId} sessionId={selection?.sessionId}
    initialSend={!selection && firstSend?.conversationId === shownId ? firstSend : undefined}
    onInitialSend={dispatched => {
      if (firstSend) {
        if (dispatched) firstSend.attachmentIds.forEach(removeFile);
        else restoreDraft(firstSend.text);
      }
      setFirstSend(null);
    }} context="page" isReadOnly={selection?.isReadOnly || permissions?.canEdit !== true}
    imagoComposer={{ placeholder: placeholder ?? `Message ${name}...`, aboveComposer }} /></RetainedSurface>;
}
