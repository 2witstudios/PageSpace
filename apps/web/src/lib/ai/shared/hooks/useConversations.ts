/**
 * useConversations - Shared hook for conversation management
 * Used by both Agent engine and Global Assistant engine
 */

import { useCallback, useMemo } from 'react';
import useSWR, { mutate } from 'swr';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { toast } from 'sonner';
import type { UIMessage } from 'ai';
import {
  ConversationData,
  RawConversationData,
  parseConversationsData,
} from '../chat-types';

interface UseConversationsOptions {
  /**
   * For agent mode: the agent/page ID
   * For global mode: null
   */
  agentId: string | null;
  /**
   * Current conversation ID
   */
  currentConversationId: string | null;
  /**
   * Whether to fetch conversations (e.g., only when history tab is active)
   */
  enabled?: boolean;
  /**
   * Callbacks for state updates
   */
  onConversationLoad?: (conversationId: string, messages: UIMessage[]) => void;
  onConversationCreate?: (conversationId: string) => void;
  onConversationDelete?: (conversationId: string) => void;
}

interface UseConversationsResult {
  /** List of conversations */
  conversations: ConversationData[];
  /** Whether conversations are loading */
  isLoading: boolean;
  /** Load a specific conversation */
  loadConversation: (conversationId: string) => Promise<void>;
  /** Create a new conversation */
  createConversation: () => Promise<string | null>;
  /** Delete a conversation */
  deleteConversation: (conversationId: string) => Promise<void>;
  /** Refresh conversations list */
  refreshConversations: () => void;
  /** SWR key for manual cache invalidation */
  swrKey: string | null;
}

/**
 * Hook for managing conversations in AI chat views
 * Handles CRUD operations with appropriate API endpoints based on mode
 */
export function useConversations({
  agentId,
  currentConversationId,
  enabled = true,
  onConversationLoad,
  onConversationCreate,
  onConversationDelete,
}: UseConversationsOptions): UseConversationsResult {
  // Determine API endpoints based on mode
  const isAgentMode = Boolean(agentId);

  // SWR key for conversations list
  const swrKey = useMemo(() => {
    if (!enabled) return null;
    return isAgentMode
      ? `/api/ai/page-agents/${agentId}/conversations`
      : `/api/ai/global`;
  }, [enabled, isAgentMode, agentId]);

  // Fetch conversations with SWR
  const { data, isLoading } = useSWR(
    swrKey,
    async (url) => {
      const response = await fetchWithAuth(url);
      if (!response.ok) throw new Error('Failed to load conversations');
      return response.json();
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 5000,
    }
  );

  // Parse conversations data
  const conversations = useMemo<ConversationData[]>(() => {
    if (!data?.conversations) return [];
    return parseConversationsData(data.conversations as RawConversationData[]);
  }, [data]);

  // Load a specific conversation
  const loadConversation = useCallback(
    async (conversationId: string) => {
      try {
        const messagesUrl = isAgentMode
          ? `/api/ai/page-agents/${agentId}/conversations/${conversationId}/messages`
          : `/api/ai/global/${conversationId}/messages`;

        const response = await fetchWithAuth(messagesUrl);
        if (response.ok) {
          const messagesData = await response.json();
          const messages = messagesData.messages || [];
          onConversationLoad?.(conversationId, messages);
          toast.success('Conversation loaded');
        } else {
          throw new Error('Failed to load conversation');
        }
      } catch (error) {
        console.error('Failed to load conversation:', error);
        toast.error('Failed to load conversation');
      }
    },
    [isAgentMode, agentId, onConversationLoad]
  );

  // Create a new conversation
  const createConversation = useCallback(async (): Promise<string | null> => {
    try {
      const createUrl = isAgentMode
        ? `/api/ai/page-agents/${agentId}/conversations`
        : `/api/ai/global`;

      const response = await fetchWithAuth(createUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isAgentMode ? {} : { type: 'global' }),
      });

      if (response.ok) {
        const data = await response.json();
        const newConversationId = data.conversationId || data.id;

        // Invalidate SWR cache
        if (swrKey) {
          mutate(swrKey);
        }

        onConversationCreate?.(newConversationId);
        toast.success('New conversation started');
        return newConversationId;
      }
      return null;
    } catch (error) {
      console.error('Failed to create conversation:', error);
      toast.error('Failed to create new conversation');
      return null;
    }
  }, [isAgentMode, agentId, swrKey, onConversationCreate]);

  // Delete a conversation
  const deleteConversation = useCallback(
    async (conversationId: string) => {
      try {
        const deleteUrl = isAgentMode
          ? `/api/ai/page-agents/${agentId}/conversations/${conversationId}`
          : `/api/ai/global/${conversationId}`;

        const response = await fetchWithAuth(deleteUrl, { method: 'DELETE' });

        if (response.ok) {
          // Invalidate SWR cache
          if (swrKey) {
            mutate(swrKey);
          }

          // If deleting current conversation, notify parent
          if (conversationId === currentConversationId) {
            onConversationDelete?.(conversationId);
          }

          toast.success('Conversation deleted');
        }
      } catch (error) {
        console.error('Failed to delete conversation:', error);
        toast.error('Failed to delete conversation');
      }
    },
    [isAgentMode, agentId, swrKey, currentConversationId, onConversationDelete]
  );

  // Refresh conversations list
  const refreshConversations = useCallback(() => {
    if (swrKey) {
      mutate(swrKey);
    }
  }, [swrKey]);

  return {
    conversations,
    isLoading,
    loadConversation,
    createConversation,
    deleteConversation,
    refreshConversations,
    swrKey,
  };
}
