'use client';

// The chat pane in the shell's chat slot: the agent chosen in its header
// (Imago unless another is), that agent's latest conversation (or the one the
// shell state names), the live turn and the composer. The shell keeps it
// mounted across every navigation; the agent, the draft and the open
// conversation live in shell state besides, so they outlast the pane too.
// Opening an object changes only the context a turn carries, never the agent
// or the conversation.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/api/errors';
import { useApiClient } from '@/api/swr-provider';
import { getUiState, useUiState } from '@/ui/store/store';
import type { UiState } from '@/ui/store/state';
import { dispatch, transactions } from '@/ui/store/transactions';
import { usePageTrail } from '@/ui/tasks/use-tasks/use-tasks';
import { ListOpener } from '../../frame/list-pane/list-pane';
import { chatContextFor, type Stage } from '../../frame/stage/stage';
import { agentFor, agentMenu } from '../chat-agents/chat-agents';
import { createConversation } from '../chat-api/chat-api';
import { shownConversationId } from '../chat-plugin';
import { contextRefFor } from '../chat-context/context-ref';
import { useAgentChat } from '../use-agent-chat/use-agent-chat';
import { useAgentConversations, useDriveAgents } from '../use-chat-data/use-chat-data';
import { useChatAgent } from '../use-chat-agent/use-chat-agent';
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
const selectNew = (state: UiState) => state.resources.chatNew;
const selectStreamingInto = (state: UiState) => state.resources.streaming?.conversationId ?? null;
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

/** Within this many pixels of the end, the thread follows a growing reply. */
const FOLLOW_SLACK = 80;

/** The open page's own name: the last step of its trail, once it is that page's. */
const objectNameOf = (stage: Stage, trail: readonly { readonly id: string; readonly title: string }[] | undefined) => {
  const last = trail?.at(-1);
  return stage.object?.kind === 'page' && last?.id === stage.object.pageId ? last.title : undefined;
};

export function ChatPane({ stage, driveName, homeDriveId }: ChatPaneProps) {
  const client = useApiClient();
  const { agents, chosenAgent, agentId, agentName, error: agentsError } = useChatAgent();
  const { agents: driveAgents } = useDriveAgents(stage.driveId);
  const lost = useUiState(selectLost);
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
  const context = chatContextFor(stage, { drive: driveName, object: objectNameOf(stage, trail) });
  const chat = useAgentChat(agentId, conversationId, { contextRef: contextRefFor(stage) });
  const draft = useUiState(selectDraft);
  const [failed, setFailed] = useState(false);
  const sending = useRef(false);

  const unprovisioned = chosenAgent === null && agents !== undefined && agentId === null;
  // Which conversation is latest is unknown until the list loads: a send then
  // would start a new one instead of continuing it. A list that failed to load
  // leaves only a new conversation to send into.
  // A new chat needs no list: its conversation is created by the send.
  const resolving = !chatNew && chosen === null && conversations === undefined && conversationsError === undefined;
  const streaming = chat.status === 'submitted' || chat.status === 'streaming';
  // One turn at a time: while a reply streams into a chat other than this one
  // (another thread, or before a New chat has one), a send here would be refused.
  const streamingInto = useUiState(selectStreamingInto);
  const busyElsewhere = streamingInto !== null && streamingInto !== conversationId;

  const send = async () => {
    const text = draft;
    if (agentId === null || resolving || busyElsewhere || text.trim() === '' || sending.current) return;
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

  // No agent, a new chat, or none of the agent's conversations yet: an empty thread, not a loading one.
  const empty = unprovisioned || (conversationId === null && (chatNew || conversations !== undefined));
  const messages = useMemo(() => (empty ? [] : chat.messages), [empty, chat.messages]);
  const last = messages?.at(-1);
  const streamingMessageId = streaming && last?.role === 'assistant' ? last.id : null;

  // The lost agent is said last: it stays until another agent is chosen, so
  // ahead of the rest it would hide a later failure under Imago.
  const notice = (() => {
    if (unprovisioned) return NOTICES.setup;
    if (agentsError !== undefined || conversationsError !== undefined || chat.loadError !== undefined) return NOTICES.load;
    if (busyElsewhere) return NOTICES.elsewhere;
    if (failed || chat.status === 'error') return NOTICES.reply;
    if (chat.error !== undefined) return NOTICES.stop;
    if (lost !== null) return NOTICES.lost(lost);
    return null;
  })();

  // Back in the chat from another section, the caret is back in the composer,
  // with whatever draft was left there.
  const field = useRef<HTMLTextAreaElement>(null);
  const section = useRef(stage.section);
  useEffect(() => {
    const returned = stage.section === 'chat' && section.current !== 'chat';
    section.current = stage.section;
    if (returned) field.current?.focus();
  }, [stage.section]);

  // Keep the newest message in view while the viewer is reading the end.
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // Another thread opens at its end, whatever was scrolled in the last one.
  const shown = useRef(conversationId);
  if (shown.current !== conversationId) {
    shown.current = conversationId;
    following.current = true;
  }
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && following.current) element.scrollTop = element.scrollHeight;
  }, [messages]);

  return renderChatPane({
    density: context.density,
    agentName,
    // The hidden history's hamburger sits in the chat's own header, as the tree's does in the object's.
    leading: stage.section === 'chat' && historyHidden ? <ListOpener section="chat" title="Chat history" /> : null,
    agents: agentMenu({ builtins: agents, driveAgents, driveName, selected: chosenAgent }),
    selectAgent: (value) => {
      const next = agentFor({ builtins: agents, driveAgents }, value);
      if (next !== undefined) dispatch(transactions.selectAgent, next);
    },
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
      disabled: agentId === null || resolving || busyElsewhere,
      typeDraft: (next) => dispatch(transactions.setChatDraft, next),
      send: () => void send(),
      stop: () => void chat.stop(),
      fieldRef: field,
    }),
  });
}
