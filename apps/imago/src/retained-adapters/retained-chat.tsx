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
import { useImagoPageId } from '@/ui/chat/use-chat-data/use-chat-data';
import { ImagoOrb } from '@/ui/metal/imago-orb/imago-orb';
import { ImagoThread } from '@/ui/metal/imago-thread';
import { useImagoPhase } from './imago-phase';
import { useApiClient } from '@/api/swr-provider';
import { createConversation } from '@/ui/chat/chat-api/chat-api';
import { dispatch, transactions } from '@/ui/store/transactions';
import { renderLoadingState, renderErrorState } from '@/ui/frame/edge-state/edge-state.render';
import { HomeLine } from '@/retained/components/ai/chat/layouts/HomeLine';
import { HomeSuggestions } from '@/retained/components/ai/chat/layouts/HomeSuggestions';
import { useHomeSignals } from '@/retained/hooks/useHomeSignals';
import { SpendStrip } from '@/ui/chat/spend-strip/spend-strip';
import { useDriveSpend } from '@/retained/hooks/useConversationSpend';
import { OnboardingGate } from '@/retained/components/onboarding/OnboardingGate';

/** Classic's Home line and suggestions for a new, empty conversation; picking one fills the composer. */
function HomeWelcome({ imago }: { imago: boolean }) {
  const { line } = useHomeSignals();
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto px-4">
    {imago && <ImagoOrb size="hero" live label="Imago" />}
    <HomeLine line={line} />
    <HomeSuggestions suggestions={line.suggestions} onSelect={text => dispatch(transactions.setChatDraft, text)} />
  </div>;
}

type RetainedChatProps = {
  agentId: string | null; name: string; conversationId: string | null; resolving: boolean;
  /** Imago's chat home (section 'chat'): a new, empty conversation greets the user with the Home line. */
  home?: boolean;
  /** The composer's invitation for what Imago answers about (chatContextFor): "Ask about this page…". */
  placeholder?: string;
  /** Imago's spend strip, directly above the composer (IMC-2.4). */
  aboveComposer?: React.ReactNode;
  /** The host renders its own out-of-credits alert in aboveComposer, so the built-in banner steps aside for that cause (IMC-10.10). */
  ownsCreditsAlert?: boolean;
  /**
   * Stay on `agentId` and this conversation, ignoring the global selection (the agent page's Chat
   * tab, IMC-3.11): selecting an agent elsewhere must not move this chat, and this chat must not
   * move the Imago column.
   */
  isolated?: boolean;
};

/**
 * One chat host for Imago and any agent page. In Imago's own chat its orb stands in for the
 * spinner, and the chat is marked so the orb listens while the viewer types to it.
 */
export function RetainedChat(props: RetainedChatProps) {
  // The agent and conversation actually shown: a shared selection overrides the props, as in the host.
  const sharedSelection = useRetainedChatSelection(state => state.selection);
  const selection = props.isolated ? null : sharedSelection;
  const shownAgentId = selection ? selection.agentId : props.agentId;
  const imagoPageId = useImagoPageId();
  const imago = imagoPageId !== null && shownAgentId === imagoPageId;
  useImagoPhase(imago ? (selection?.conversationId ?? props.conversationId) : null);
  return <ImagoThread value={imago}>
    <div className="contents" {...(imago ? { 'data-imago-chat': '' } : {})}><RetainedChatHost {...props} imago={imago} /></div>
  </ImagoThread>;
}

function RetainedChatHost({ agentId, name, conversationId, resolving, placeholder, aboveComposer, ownsCreditsAlert, home, isolated, imago }: RetainedChatProps & { imago: boolean }) {
  const sharedSelection = useRetainedChatSelection(state => state.selection);
  const selection = isolated ? null : sharedSelection;
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
  // JOURNEYS-2: the first send in a drive waits for the drive's spend preview to RESOLVE.
  // undefined = no drive context (never gated); false = still pending or failed (gated).
  const firstSendDrivePreview = useDriveSpend(page?.driveId ?? null);
  const firstSendPreviewResolved: boolean | undefined = page?.driveId
    ? firstSendDrivePreview.spend !== null
    : undefined;
  const restoreDraft = (text: string) => {
    if (getUiState().resources.chatDraft === '') dispatch(transactions.setChatDraft, text);
  };
  const latest = useRef(agentId);
  latest.current = agentId;
  const chooseDraftSource = async (walletId: string): Promise<void> => {
    if (creating.current || !agentId || !page || permissions?.canEdit !== true) throw new Error('This conversation cannot be started right now.');
    creating.current = true;
    setPreparing(true);
    setCreationError(false);
    try {
      // The server validates the selected source before writing it on the new row. No message is sent here.
      const id = await createConversation(client, agentId, walletId);
      if (latest.current !== agentId || (!isolated && useRetainedChatSelection.getState().selection !== null)) throw new Error('The selected chat changed. Choose the source again.');
      dispatch(transactions.openConversation, id);
    } catch (error) {
      setCreationError(true);
      throw error;
    } finally {
      creating.current = false;
      setPreparing(false);
    }
  };
  const prepareFirstSend = async () => {
    const text = getUiState().resources.chatDraft;
    const files = getFilesForSend();
    if (creating.current || !agentId || !page || permissions?.canEdit !== true || (!text.trim() && !files.length)) return;
    // JOURNEYS-2: unresolved source preview → no conversation, no charge. The strip above
    // the composer shows the loading/retry state; the send resumes once it resolves.
    if (page.driveId && firstSendPreviewResolved === false) return;
    creating.current = true;
    setPreparing(true);
    setCreationError(false);
    const attachmentIds = attachments.filter(item => !item.processing && item.dataUrl).map(item => item.id);
    dispatch(transactions.setChatDraft, '');
    try {
      const id = await createConversation(client, agentId);
      if (latest.current !== agentId || (!isolated && useRetainedChatSelection.getState().selection !== null)) {
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
  if (!shownId) return <RetainedSurface><div className="@container flex h-full min-w-0 min-h-0 flex-col">
    <div className="min-h-0 min-w-0 flex-1 overflow-hidden flex flex-col">{home
      ? <HomeWelcome imago={imago} />
      : <ChatMessagesArea messages={[]} isLoading={false} isStreaming={false} />}</div>
    {home && <OnboardingGate />}
    {creationError && <p role="alert" className="px-2 text-sm text-destructive">Could not open this chat. Try sending again.</p>}
    <div className="p-2">{aboveComposer}<SpendStrip conversationId={null} driveId={page.driveId} onChooseDraftSource={permissions?.canEdit === true && !preparing ? chooseDraftSource : undefined} /><ChatInput value={input}
      onChange={value => dispatch(transactions.setChatDraft, value)} onSend={() => void prepareFirstSend()}
      disabled={preparing || permissions?.canEdit !== true}
      sendDisabled={firstSendPreviewResolved === false} isStreaming={false} onStop={() => undefined} hideModelSelector variant="sidebar" showMention
      placeholder={placeholder ?? `Message ${name}...`} inputLabel={`Message ${name}`} hasVision={hasVisionCapability(page.aiModel || '')}
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
    imagoComposer={{ placeholder: placeholder ?? `Message ${name}...`, aboveComposer, ownsCreditsAlert }} /></RetainedSurface>;
}
