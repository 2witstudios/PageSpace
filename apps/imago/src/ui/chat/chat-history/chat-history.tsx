'use client';

// The chat section's list: the chat agent's past conversations from the
// conversations route (SWR's shared cache, the same list the chat pane reads
// for its latest), grouped by the viewer's day. Picking one or New chat only
// changes shell state, so the pane, its composer and the rail stay mounted.

import { useEffect, useRef, useState } from 'react';
import { useUiState } from '@/ui/store/store';
import type { UiState } from '@/ui/store/state';
import { dispatch, transactions } from '@/ui/store/transactions';
import { shownConversationId } from '../chat-plugin';
import { useAgentConversations } from '../use-chat-data/use-chat-data';
import { useChatAgent } from '../use-chat-agent/use-chat-agent';
import { historyDays, untilNextDay } from './history-days';
import { renderChatHistory, type ChatHistoryList } from './chat-history.render';

const selectConversation = (state: UiState) => state.resources.chatConversationId;
const selectNew = (state: UiState) => state.resources.chatNew;
const selectStreaming = (state: UiState) => state.resources.streaming?.conversationId ?? null;

export function ChatHistory() {
  const { agents, agentId, error: agentsError } = useChatAgent();
  const { conversations, error, hasMore, isLoadingMore, loadMore, revalidate } = useAgentConversations(agentId);
  const chatConversationId = useUiState(selectConversation);
  const chatNew = useUiState(selectNew);
  const activeId = shownConversationId({ chatConversationId, chatNew }, conversations?.[0]?.id ?? null);

  // Days are read from the clock on every render. A re-render is forced at
  // the viewer's next midnight, and when the page is shown or focused again:
  // a laptop asleep across midnight fires no timer on time.
  const [day, setDay] = useState(0);
  useEffect(() => {
    const refresh = () => setDay((count) => count + 1);
    const timer = setTimeout(refresh, untilNextDay(new Date()));
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [day]);

  // A turn starting or ending changes the list: a new chat's first send
  // creates its conversation, and every reply moves its chat to the top.
  const streaming = useUiState(selectStreaming);
  const seen = useRef(streaming);
  useEffect(() => {
    if (seen.current === streaming) return;
    seen.current = streaming;
    void revalidate();
  }, [streaming, revalidate]);

  const list = ((): ChatHistoryList => {
    // An agent not provisioned yet has no conversations to list.
    if (agents !== undefined && agentId === null) return { status: 'ready', days: [], hasMore: false, loadingMore: false };
    if (agentsError !== undefined || error !== undefined) return { status: 'error' };
    if (conversations === undefined) return { status: 'loading' };
    return { status: 'ready', days: historyDays(conversations, new Date()), hasMore, loadingMore: isLoadingMore };
  })();

  return renderChatHistory({
    list,
    activeId,
    selectConversation: (conversationId) => dispatch(transactions.openConversation, conversationId),
    startNewChat: () => dispatch(transactions.startNewChat, undefined),
    hide: () => dispatch(transactions.collapseSection, 'chat'),
    loadMore: () => void loadMore(),
    retry: () => void revalidate(),
  });
}
