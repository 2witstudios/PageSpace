'use client';

// The chat pane in the shell's chat slot: the viewer's Imago agent, its
// latest conversation (or the one the shell state names), the live turn and
// the composer. The shell keeps it mounted across every navigation; the
// draft and the open conversation live in shell state besides, so they
// outlast the pane too.

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApiClient } from '@/api/swr-provider';
import { getUiState, useUiState } from '@/ui/store/store';
import type { UiState } from '@/ui/store/state';
import { dispatch, transactions } from '@/ui/store/transactions';
import { usePageTrail } from '@/ui/tasks/use-tasks/use-tasks';
import { chatContextFor, type Stage } from '../../frame/stage/stage';
import { createConversation } from '../chat-api/chat-api';
import { contextRefFor } from '../chat-context/context-ref';
import { useAgentChat } from '../use-agent-chat/use-agent-chat';
import { useAgentConversations, useImagoAgents } from '../use-chat-data/use-chat-data';
import { renderComposer } from '../composer/composer.render';
import { renderChatPane } from './chat-pane.render';

export type ChatPaneProps = {
  readonly stage: Stage;
  /** The open drive's name, once the drive list has it. */
  readonly driveName?: string;
  /** Where a cited page opens when the stage names no drive. */
  readonly homeDriveId: string | null;
};

const selectDraft = (state: UiState) => state.resources.chatDraft;
const selectConversation = (state: UiState) => state.resources.chatConversationId;

const NOTICES = {
  setup: 'Imago is still being set up. Try again in a moment.',
  load: 'This chat could not load. Try again in a moment.',
  reply: 'The reply failed. Try again.',
  stop: 'The reply could not be stopped.',
} as const;

/** Within this many pixels of the end, the thread follows a growing reply. */
const FOLLOW_SLACK = 80;

/** The open page's own name: the last step of its trail, once it is that page's. */
const objectNameOf = (stage: Stage, trail: readonly { readonly id: string; readonly title: string }[] | undefined) => {
  const last = trail?.at(-1);
  return stage.object?.kind === 'page' && last?.id === stage.object.pageId ? last.title : undefined;
};

export function ChatPane({ stage, driveName, homeDriveId }: ChatPaneProps) {
  const client = useApiClient();
  const { agents, error: agentsError } = useImagoAgents();
  // IMG-6.4 selects among the agents; until then the chat is Imago's.
  const agent = agents?.find((entry) => entry.key === 'imago');
  const agentId = agent?.pageId ?? null;
  const { conversations, error: conversationsError } = useAgentConversations(agentId);
  const chosen = useUiState(selectConversation);
  const conversationId = chosen ?? conversations?.[0]?.id ?? null;

  const { trail } = usePageTrail(stage.object?.kind === 'page' ? stage.object.pageId : null);
  const context = chatContextFor(stage, { drive: driveName, object: objectNameOf(stage, trail) });
  const chat = useAgentChat(agentId, conversationId, { contextRef: contextRefFor(stage) });
  const draft = useUiState(selectDraft);
  const [failed, setFailed] = useState(false);
  const sending = useRef(false);

  const unprovisioned = agents !== undefined && agentId === null;
  const streaming = chat.status === 'submitted' || chat.status === 'streaming';

  const send = async () => {
    const text = draft;
    if (agentId === null || text.trim() === '' || sending.current) return;
    sending.current = true;
    setFailed(false);
    dispatch(transactions.setChatDraft, '');
    try {
      let target = conversationId;
      if (target === null) {
        target = await createConversation(client, agentId);
        dispatch(transactions.openConversation, target);
      }
      if (await chat.send(text, target)) return;
    } catch {
      setFailed(true);
    } finally {
      sending.current = false;
    }
    // Not taken: the prompt goes back where it was, unless something new was typed.
    if (getUiState().resources.chatDraft === '') dispatch(transactions.setChatDraft, text);
  };

  // No agent, or none of its conversations yet: an empty thread, not a loading one.
  const empty = unprovisioned || (conversationId === null && conversations !== undefined);
  const messages = useMemo(() => (empty ? [] : chat.messages), [empty, chat.messages]);
  const last = messages?.at(-1);
  const streamingMessageId = streaming && last?.role === 'assistant' ? last.id : null;

  const notice = (() => {
    if (unprovisioned) return NOTICES.setup;
    if (agentsError !== undefined || conversationsError !== undefined || chat.loadError !== undefined) return NOTICES.load;
    if (failed || chat.status === 'error') return NOTICES.reply;
    if (chat.error !== undefined) return NOTICES.stop;
    return null;
  })();

  // Keep the newest message in view while the viewer is reading the end.
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && following.current) element.scrollTop = element.scrollHeight;
  }, [messages]);

  const agentName = agent?.title ?? 'Imago';
  return renderChatPane({
    density: context.density,
    agentName,
    contextLabel: context.contextLabel,
    messages,
    streamingMessageId,
    notice,
    citationDriveId: stage.driveId ?? homeDriveId,
    scrollRef: scroller,
    onScroll: (event) => {
      const element = event.currentTarget;
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK;
    },
    composer: renderComposer({
      draft,
      label: `Message ${agentName}`,
      placeholder: context.placeholder,
      density: context.density,
      streaming,
      disabled: agentId === null,
      typeDraft: (next) => dispatch(transactions.setChatDraft, next),
      send: () => void send(),
      stop: () => void chat.stop(),
    }),
  });
}
