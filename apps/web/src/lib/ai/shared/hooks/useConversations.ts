/**
 * useConversations - Shared hook for conversation management
 * Used by both Agent engine and Global Assistant engine
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import useSWR, { mutate } from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import { createId } from '@paralleldrive/cuid2';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';
import type { UIMessage } from 'ai';
import { useEditingStore } from '@/stores/useEditingStore';
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

/** The shape `/api/ai/global?paginated=true` actually returns per conversation
 * (globalConversationRepository.ConversationSummary, serialized over JSON). */
interface GlobalConversationSummary {
  id: string;
  title: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  sessionId: string | null;
}

/** Bridges GlobalConversationSummary to RawConversationData — see the cacheKey
 * comment below for why this exists. */
function adaptGlobalConversationSummary(raw: GlobalConversationSummary): RawConversationData {
  return {
    id: raw.id,
    title: raw.title ?? 'New conversation',
    preview: '',
    createdAt: raw.createdAt,
    updatedAt: raw.lastMessageAt ?? raw.createdAt,
    messageCount: 0,
    sessionId: raw.sessionId,
    lastMessage: { role: '', timestamp: raw.lastMessageAt ?? raw.createdAt },
  };
}

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
  onConversationLoadError?: (conversationId: string, error: Error) => void;
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
  /** Delete a conversation. Resolves to whether it actually succeeded — a refused delete (e.g. a 409) or a network failure both resolve `false`, never throw. */
  deleteConversation: (conversationId: string) => Promise<boolean>;
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
  onConversationLoadError,
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
  //
  // Global mode uses the PAGINATED endpoint (`?paginated=true`), not the
  // legacy bare-array one: the legacy shape has no `.conversations` wrapper
  // at all, so this hook's `data?.conversations` read silently resolved to
  // nothing and the Assistant's History tab was always empty (review
  // finding — chatgpt-codex-connector on PR #2299, round 13).
  const cacheKey = useMemo(
    () =>
      isAgentMode
        ? `/api/ai/page-agents/${agentId}/conversations`
        : `/api/ai/global?paginated=true`,
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
      const json = await response.json();
      if (isAgentMode) return json; // already { conversations: RawConversationData[] }
      // The paginated global endpoint's ConversationSummary is narrower than
      // RawConversationData — no preview/messageCount/lastMessage (those
      // require a join this repository doesn't do yet). Adapted here with
      // safe placeholders so the list renders at all rather than staying
      // empty; a richer summary query is a scoped follow-up, not required
      // to fix the reported bug (the list being empty).
      const summaries = (json.conversations ?? []) as GlobalConversationSummary[];
      return { conversations: summaries.map(adaptGlobalConversationSummary) };
    },
    {
      // Only pause revalidation after initial load - never block the first fetch
      isPaused: () => hasLoadedRef.current && useEditingStore.getState().isAnyEditing(),
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
        isShared: false,
        isOwner: true,
        sessionId: e.sessionId ?? null,
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
        const err = error instanceof Error ? error : new Error('Failed to load conversation');
        onConversationLoadError?.(conversationId, err);
        console.error('Failed to load conversation:', err);
        toast.error('Failed to load conversation');
      }
    },
    [isAgentMode, agentId, onConversationLoad, onConversationLoadError]
  );

  // Create a new conversation.
  //
  // Agent mode: the id is generated client-side (cuid2) and handed to the
  // caller synchronously — the create POST is a fire-and-forget, idempotent
  // persist (the page-agents route accepts and honors a client-supplied id),
  // not the mechanism used to learn the id. This closes the race where a
  // send fired before the old server round trip resolved would carry a
  // stale conversationId.
  //
  // Global mode: the /api/ai/global route does not accept a client-supplied
  // id (it always mints its own), so this path keeps the original
  // await-then-adopt-the-server-id behavior to avoid diverging from what was
  // actually persisted.
  const createConversation = useCallback(async (): Promise<string | null> => {
    if (!isAgentMode) {
      try {
        const response = await fetchWithAuth('/api/ai/global', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Browser-Session-Id': getBrowserSessionId(),
          },
          body: JSON.stringify({ type: 'global' }),
        });

        if (!response.ok) return null;

        const data = await response.json();
        const newConversationId = data.conversationId || data.id;
        if (swrKey) mutate(swrKey);
        onConversationCreate?.(newConversationId);
        return newConversationId;
      } catch (error) {
        console.error('Failed to create conversation:', error);
        toast.error('Failed to create new conversation');
        return null;
      }
    }

    const conversationId = createId();
    onConversationCreate?.(conversationId);

    try {
      const response = await fetchWithAuth(`/api/ai/page-agents/${agentId}/conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Browser-Session-Id': getBrowserSessionId(),
        },
        body: JSON.stringify({ conversationId }),
      });

      if (response.ok) {
        if (swrKey) mutate(swrKey);
      } else {
        console.error('Failed to persist new conversation');
        toast.error('Failed to create new conversation');
      }
    } catch (error) {
      console.error('Failed to create conversation:', error);
      toast.error('Failed to create new conversation');
    }

    return conversationId;
  }, [isAgentMode, agentId, swrKey, onConversationCreate]);

  // Delete a conversation. Returns whether it actually succeeded — a caller
  // that reacts to the deletion (e.g. resetting UI bound to this
  // conversationId) must not do so on a REFUSED delete (a 409, e.g. "this
  // is the session's only open listing") or a network failure, both of
  // which leave the conversation exactly as it was server-side (review
  // finding — chatgpt-codex-connector and coderabbitai on PR #2299: the
  // previous version resolved regardless of outcome, with no way for a
  // caller to tell success from failure).
  const deleteConversation = useCallback(
    async (conversationId: string): Promise<boolean> => {
      try {
        const deleteUrl = isAgentMode
          ? `/api/ai/page-agents/${agentId}/conversations/${conversationId}`
          : `/api/ai/global/${conversationId}`;

        const response = await fetchWithAuth(deleteUrl, { method: 'DELETE' });

        if (!response.ok) {
          // Surface WHY — a 409 is a real, intentional refusal (not a
          // transient failure), and silently doing nothing left it
          // invisible to the user.
          let message = 'Failed to delete conversation';
          try {
            const body = await response.json();
            if (typeof body?.error === 'string') message = body.error;
          } catch {
            // Non-JSON error body — fall back to the generic message.
          }
          toast.error(message);
          return false;
        }

        // Invalidate SWR cache
        if (swrKey) {
          mutate(swrKey);
        }

        // If deleting current conversation, notify parent
        if (conversationId === currentConversationId) {
          onConversationDelete?.(conversationId);
        }
        return true;
      } catch (error) {
        console.error('Failed to delete conversation:', error);
        toast.error('Failed to delete conversation');
        return false;
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
