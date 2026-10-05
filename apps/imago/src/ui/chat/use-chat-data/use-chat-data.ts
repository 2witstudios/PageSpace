'use client';

// What the chat pane reads: the viewer's Imago agents, their conversations
// with an agent page, and a conversation's messages.
//
// Everything loads through the imago client and SWR's shared cache. An Imago
// agent not provisioned yet has a null pageId, and a hook given a null id
// fetches nothing. Conversations and messages page on demand: conversations
// forward by page number, messages backward from the newest by cursor.

import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';
import { useApiClient } from '@/api/swr-provider';
import type { AgentConversation, ChatMessage, ConversationsPage, MessagesPage } from '../chat-model/chat';
import { fetchBuiltinAgents, fetchConversationMessages, fetchConversationsPage } from '../chat-api/chat-api';

/** The viewer's Imago agent pointers, in registry order. */
export const useImagoAgents = () => {
  const client = useApiClient();
  const { data, error, isLoading } = useSWR(['imago:builtin-agents'] as const, () => fetchBuiltinAgents(client));
  return { agents: data, error: error as unknown, isLoading };
};

/** Rows from every loaded page, once each: a conversation created between page loads shifts the offsets. */
const uniqueById = <T extends { readonly id: string }>(rows: readonly T[]): readonly T[] => {
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(row.id) && Boolean(seen.add(row.id)));
};

/** The viewer's conversations with an agent page, most recent first; more pages on `loadMore`. */
export const useAgentConversations = (agentId: string | null) => {
  const client = useApiClient();
  const { data, error, isLoading, isValidating, size, setSize } = useSWRInfinite(
    (page: number, previous: ConversationsPage | null) =>
      agentId === null || (previous !== null && !previous.hasMore)
        ? null
        : (['imago:agent-conversations', agentId, page] as const),
    ([, id, page]) => fetchConversationsPage(client, id, page),
  );
  const conversations: readonly AgentConversation[] | undefined =
    data === undefined ? undefined : uniqueById(data.flatMap((page) => page.conversations));
  const hasMore = data?.at(-1)?.hasMore === true;
  return {
    conversations,
    hasMore,
    loadMore: async (): Promise<void> => {
      if (hasMore) await setSize(size + 1);
    },
    isLoading,
    isLoadingMore: isValidating && data !== undefined && data.length < size,
    error: error as unknown,
  };
};

/** A conversation's messages, oldest first, `parts` as stored; older pages on `loadOlder`. */
export const useConversationMessages = (agentId: string | null, conversationId: string | null) => {
  const client = useApiClient();
  const { data, error, isLoading, isValidating, size, setSize } = useSWRInfinite(
    (page: number, newer: MessagesPage | null) => {
      if (agentId === null || conversationId === null) return null;
      if (page === 0) return ['imago:conversation-messages', agentId, conversationId, null] as const;
      return newer?.olderCursor ? (['imago:conversation-messages', agentId, conversationId, newer.olderCursor] as const) : null;
    },
    ([, agent, conversation, cursor]) => fetchConversationMessages(client, agent, conversation, cursor ?? undefined),
  );
  // Pages arrive newest first; each page is oldest first within itself.
  const messages: readonly ChatMessage[] | undefined =
    data === undefined ? undefined : [...data].reverse().flatMap((page) => page.messages);
  const hasOlder = data !== undefined && (data.at(-1)?.olderCursor ?? null) !== null;
  return {
    messages,
    hasOlder,
    loadOlder: async (): Promise<void> => {
      if (hasOlder) await setSize(size + 1);
    },
    /** The rev the newest page was read at, the watermark for live updates. */
    rev: data?.[0]?.rev ?? null,
    isLoading,
    isLoadingOlder: isValidating && data !== undefined && data.length < size,
    error: error as unknown,
  };
};
