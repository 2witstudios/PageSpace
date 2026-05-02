/**
 * useConversations - Shared hook for conversation management
 * Used by both Agent engine and Global Assistant engine
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import useSWR, { mutate } from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';
import type { UIMessage } from 'ai';
import { isEditingActive } from '@/stores/useEditingStore';
import { useOptimisticConversationsStore } from '@/stores/useOptimisticConversationsStore';
import {
  ConversationData,
  RawConversationData,
  parseConversationsData,
} from '../chat-types';
import type { OptimisticConversationEntry } from '@/stores/useOptimisticConversationsStore';

// Stable empty array so the Zustand selector returns a referentially-stable
// value when no optimistic entries exist (prevents unnecessary re-renders).
const EMPTY_OPTIMISTIC: OptimisticConversationEntry[] = [];

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
  /**
   * Optimistically prepend a conversation to the locally-rendered list. Use
   * when a remote tab created the conversation (chat:conversation_added
   * broadcast). Persists in a Zustand store keyed by the cache URL so the
   * entry survives the (1) hook-disabled state when `enabled === false`
   * (e.g. AiChatView's history tab not yet active), and (2) the SWR refetch
   * triggered when the hook later enables — page-agent rows are materialized
   * lazily on first message save and would not yet appear in a server fetch.
   * The store entry is auto-pruned once the SWR fetch confirms the row.
   */
  prependConversationOptimistic: (entry: OptimisticConversationEntry) => void;
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

  // Track if initial data has been loaded to avoid blocking first fetch
  const hasLoadedRef = useRef(false);

  // Cache key — always computed regardless of `enabled` so the optimistic
  // store can be addressed across hook-mount lifetimes (e.g. when a
  // chat:conversation_added broadcast arrives while the history tab is
  // closed).
  const cacheKey = useMemo(
    () =>
      isAgentMode
        ? `/api/ai/page-agents/${agentId}/conversations`
        : `/api/ai/global`,
    [isAgentMode, agentId],
  );
  // SWR key for conversations list — null disables the SWR fetch.
  const swrKey = enabled ? cacheKey : null;

  // Fetch conversations with SWR
  const { data, isLoading } = useSWR(
    swrKey,
    async (url) => {
      const response = await fetchWithAuth(url);
      if (!response.ok) throw new Error('Failed to load conversations');
      return response.json();
    },
    {
      // Only pause revalidation after initial load - never block the first fetch
      isPaused: () => hasLoadedRef.current && isEditingActive(),
      onSuccess: () => {
        hasLoadedRef.current = true;
      },
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 5000,
    }
  );

  // Optimistic-conversation entries received via chat:conversation_added
  // broadcasts before this hook's SWR fetch can confirm them.
  const optimisticEntries = useOptimisticConversationsStore(
    (state) => state.byKey[cacheKey] ?? EMPTY_OPTIMISTIC,
  );
  const pruneOptimistic = useOptimisticConversationsStore((state) => state.prune);

  // Parse + merge SWR data and optimistic entries, dedup by id.
  const conversations = useMemo<ConversationData[]>(() => {
    const fromSwr = data?.conversations
      ? parseConversationsData(data.conversations as RawConversationData[])
      : [];
    if (optimisticEntries.length === 0) return fromSwr;
    const knownIds = new Set(fromSwr.map((c) => c.id));
    const optimisticParsed = optimisticEntries
      .filter((e) => !knownIds.has(e.id))
      .map<ConversationData>((e) => ({
        id: e.id,
        title: e.title,
        preview: '',
        createdAt: new Date(e.createdAt),
        updatedAt: new Date(e.createdAt),
        messageCount: 0,
        lastMessage: { role: '', timestamp: new Date(e.createdAt) },
      }));
    return [...optimisticParsed, ...fromSwr];
  }, [data, optimisticEntries]);

  // Prune optimistic entries whose id has been confirmed by the server fetch.
  useEffect(() => {
    if (!data?.conversations) return;
    const ids = (data.conversations as RawConversationData[]).map((c) => c.id);
    if (ids.length === 0) return;
    pruneOptimistic(cacheKey, ids);
  }, [data, cacheKey, pruneOptimistic]);

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
        headers: {
          'Content-Type': 'application/json',
          'X-Browser-Session-Id': getBrowserSessionId(),
        },
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

  const addOptimistic = useOptimisticConversationsStore((state) => state.add);
  const prependConversationOptimistic = useCallback(
    (entry: OptimisticConversationEntry) => {
      addOptimistic(cacheKey, entry);
    },
    [cacheKey, addOptimistic],
  );

  return {
    conversations,
    isLoading,
    loadConversation,
    createConversation,
    deleteConversation,
    refreshConversations,
    prependConversationOptimistic,
    swrKey,
  };
}
