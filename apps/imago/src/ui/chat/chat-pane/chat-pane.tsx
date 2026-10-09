'use client';

// The chat pane in the shell's chat slot: the agent chosen in its header
// (Imago unless another is), that agent's latest conversation (or the one the
// shell state names), the live turn and the composer. The shell keeps it
// mounted across every navigation; the agent, the draft and the open
// conversation live in shell state besides, so they outlast the pane too.
// Opening an object changes only the context a turn carries, never the agent
// or the conversation.

import { useEffect, useRef } from 'react';
import { useRetainedChatSelection } from '@/retained-adapters/session-selection';
import { RetainedChat } from '@/retained-adapters/retained-chat';
import { ApiError } from '@/api/errors';
import { useUiState } from '@/ui/store/store';
import type { UiState } from '@/ui/store/state';
import { dispatch, transactions } from '@/ui/store/transactions';
import { usePageTrail } from '@/ui/tasks/use-tasks/use-tasks';
import { ListOpener } from '../../frame/list-pane/list-pane';
import { chatContextFor, type Stage } from '../../frame/stage/stage';
import { agentFor, agentMenu } from '../chat-agents/chat-agents';
import { shownConversationId } from '../chat-plugin';
import { useAgentConversations, useDriveAgents } from '../use-chat-data/use-chat-data';
import { useChatAgent } from '../use-chat-agent/use-chat-agent';
import { renderChatPane } from './chat-pane.render';

export type ChatPaneProps = {
  readonly stage: Stage;
  /** The open drive's name, once the drive list has it. */
  readonly driveName?: string;
  /** Where a cited page opens when the stage names no drive. */
  readonly homeDriveId: string | null;
};

const selectConversation = (state: UiState) => state.resources.chatConversationId;
const selectNew = (state: UiState) => state.resources.chatNew;
const selectHistoryHidden = (state: UiState) => state.resources.collapsedSections.includes('chat');
const selectLost = (state: UiState) => state.resources.chatAgentLost;

/** How the agent routes say the viewer may no longer use an agent: it is gone (404) or not theirs to view (403). */
const lostAccess = (error: unknown): boolean => error instanceof ApiError && (error.status === 403 || error.status === 404);

const NOTICES = {
  lost: (name: string) => `You no longer have access to ${name}, so Imago is answering.`,
  setup: 'Imago is still being set up. Try again in a moment.',
  elsewhere: 'A reply is still coming in another chat.',
  load: 'This chat could not load. Try again in a moment.',
  reply: 'The reply failed. Try again.',
  stop: 'The reply could not be stopped.',
} as const;

/** The open page's own name: the last step of its trail, once it is that page's. */
const objectNameOf = (stage: Stage, trail: readonly { readonly id: string; readonly title: string }[] | undefined) => {
  const last = trail?.at(-1);
  return stage.object?.kind === 'page' && last?.id === stage.object.pageId ? last.title : undefined;
};

export function ChatPane({ stage, driveName, homeDriveId }: ChatPaneProps) {
  const { agents, chosenAgent, agentId, agentName, error: agentsError } = useChatAgent();
  const { agents: driveAgents } = useDriveAgents(stage.driveId);
  const lost = useUiState(selectLost);
  const chatHost = useRef<HTMLDivElement>(null);
  const previousSection = useRef(stage.section);
  useEffect(() => {
    const returned = stage.section === 'chat' && previousSection.current !== 'chat';
    previousSection.current = stage.section;
    if (returned && document.querySelector('[aria-modal="true"], dialog[open]') === null) {
      chatHost.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    }
  }, [stage.section]);
  const { conversations, error: conversationsError } = useAgentConversations(agentId);
  // The server is the judge of access: a refused agent hands the chat back to Imago.
  useEffect(() => {
    if (chosenAgent !== null && lostAccess(conversationsError)) dispatch(transactions.loseAgent, chosenAgent.id);
  }, [chosenAgent, conversationsError]);
  const chosen = useUiState(selectConversation);
  const chatNew = useUiState(selectNew);
  const conversationId = shownConversationId({ chatConversationId: chosen, chatNew }, conversations?.[0]?.id ?? null);
  const historyHidden = useUiState(selectHistoryHidden);

  const { trail } = usePageTrail(stage.object?.kind === 'page' ? stage.object.pageId : null);
  const resolving = !chatNew && chosen === null && conversations === undefined && conversationsError === undefined;
  const context = chatContextFor(stage, { drive: driveName, object: objectNameOf(stage, trail) });
  return renderChatPane({
    density: context.density,
    agentName,
    // The hidden history's hamburger sits in the chat's own header, as the tree's does in the object's.
    leading: stage.section === 'chat' && historyHidden ? <ListOpener section="chat" title="Chat history" /> : null,
    agents: agentMenu({ builtins: agents, driveAgents, driveName, selected: chosenAgent }),
    selectAgent: (value) => {
      useRetainedChatSelection.getState().select(null);
      const next = agentFor({ builtins: agents, driveAgents }, value);
      if (next !== undefined) dispatch(transactions.selectAgent, next);
    },
    contextLabel: context.contextLabel,
    messages: [],
    streamingMessageId: null,
    notice: agentsError !== undefined || conversationsError !== undefined ? NOTICES.load : lost ? NOTICES.lost(lost) : null,
    citationDriveId: stage.driveId ?? homeDriveId,
    content: <div ref={chatHost} className="h-full min-h-0"><RetainedChat agentId={agentId} name={agentName} conversationId={conversationId} resolving={resolving} /></div>,
    composer: null,
  });
}
