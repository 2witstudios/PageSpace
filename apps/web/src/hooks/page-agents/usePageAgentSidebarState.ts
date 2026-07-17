import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createId } from '@paralleldrive/cuid2';
import { toast } from 'sonner';
import { AgentInfo, isValidAgentInfo } from '@/types/agent';
import {
  createAgentConversation,
  fetchMostRecentAgentConversation,
  conversationIdentityReducer,
  conversationIdFrom,
  isResolving,
  type ConversationIdentityState,
} from '@/lib/ai/shared';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { loadAgentConversationMessages } from '@/hooks/conversationMessagesLoaders';

/**
 * SidebarAgentInfo is now an alias for the shared AgentInfo type.
 * Kept for backward compatibility with existing code.
 */
export type SidebarAgentInfo = AgentInfo;

// ============================================
// Zustand Store
// ============================================

interface TransferFromDashboardPayload {
  agent: SidebarAgentInfo;
  /**
   * Agent + conversationId ONLY (PR 5B, leaf 5.3.3): the shared conversation
   * cache already holds that conversation's messages — carrying a messages
   * payload here was a hidden store-to-store message copy.
   */
  conversationId: string | null;
}

const IDLE_IDENTITY: ConversationIdentityState = { status: 'idle' };

interface SidebarAgentStoreState {
  // Agent selection
  selectedAgent: SidebarAgentInfo | null;

  // Conversation identity — single source of truth. conversationId/isInitialized
  // below are derived from this on every transition via applyIdentity, and kept
  // as plain fields (not getters) so existing selectors don't need to change.
  identity: ConversationIdentityState;
  conversationId: string | null;
  isInitialized: boolean;
  agentIdForConversation: string | null;

  // Internal state for race condition protection (not persisted)
  _loadingAgentId: string | null;

  // Actions
  selectAgent: (agent: SidebarAgentInfo | null) => void;
  applyIdentity: (action: Parameters<typeof conversationIdentityReducer>[1]) => ConversationIdentityState;
  /** Record which agent the current conversation belongs to (messages live in the shared cache). */
  markConversationLoaded: (agentId: string) => void;
  setLoadingAgentId: (agentId: string | null) => void;
  /** Transfer state from dashboard store for seamless navigation */
  transferFromDashboard: (payload: TransferFromDashboardPayload) => void;
}

export const useSidebarAgentStore = create<SidebarAgentStoreState>()(
  persist(
    (set, get) => ({
      // Initial state
      selectedAgent: null,
      identity: IDLE_IDENTITY,
      conversationId: null,
      isInitialized: false,
      agentIdForConversation: null,
      _loadingAgentId: null,

      // Actions
      selectAgent: (agent) => {
        set((state) => {
          // When selecting a new agent (or null for global), reset conversation
          // state — identity resets to idle (a genuinely new subject).
          if (agent?.id !== state.selectedAgent?.id) {
            return {
              selectedAgent: agent,
              identity: IDLE_IDENTITY,
              conversationId: null,
              isInitialized: false,
              agentIdForConversation: null,
            };
          }
          return { selectedAgent: agent };
        });
      },

      /**
       * Every conversation-identity transition funnels through the shared pure
       * reducer, so a stale async result can never clobber a newer one — a
       * RESOLVED/RESOLVE_FAILED that arrives after IDENTITY_SET already moved
       * state to 'ready' is a guaranteed no-op (see conversation-identity.ts).
       */
      applyIdentity: (action) => {
        const current = get().identity;
        const next = conversationIdentityReducer(current, action);
        if (next !== current) {
          set({
            identity: next,
            conversationId: conversationIdFrom(next),
            isInitialized: !isResolving(next) && next.status !== 'idle',
          });
        }
        return next;
      },

      markConversationLoaded: (agentId) => {
        set({ agentIdForConversation: agentId });
      },

      setLoadingAgentId: (agentId) => {
        set({ _loadingAgentId: agentId });
      },

      /**
       * Transfer state from dashboard store for seamless navigation.
       * Called when navigating from dashboard to a page while an agent is selected.
       * Carries agent + conversationId only — the shared conversation cache already
       * holds the messages, and the live stream renders from the pending-streams
       * store either way (merge-at-render).
       */
      transferFromDashboard: (payload) => {
        set({
          selectedAgent: payload.agent,
          identity: payload.conversationId
            ? { status: 'ready', conversationId: payload.conversationId }
            : IDLE_IDENTITY,
          conversationId: payload.conversationId,
          isInitialized: true,
          agentIdForConversation: payload.agent.id,
          _loadingAgentId: null,
        });
      },
    }),
    {
      name: 'pagespace:sidebar:selectedAgentData',
      // Only persist the agent selection, not conversation state
      partialize: (state) => ({
        selectedAgent: state.selectedAgent,
      }),
      // Custom storage to handle validation on restore
      storage: {
        getItem: (name) => {
          const str = localStorage.getItem(name);
          if (!str) return null;
          try {
            const parsed = JSON.parse(str);
            // Validate the stored agent data
            if (parsed?.state?.selectedAgent && !isValidAgentInfo(parsed.state.selectedAgent)) {
              localStorage.removeItem(name);
              return null;
            }
            return parsed;
          } catch {
            localStorage.removeItem(name);
            return null;
          }
        },
        setItem: (name, value) => {
          localStorage.setItem(name, JSON.stringify(value));
        },
        removeItem: (name) => {
          localStorage.removeItem(name);
        },
      },
    }
  )
);

// ============================================
// Hook Interface (for backward compatibility)
// ============================================

export interface UseSidebarAgentStateReturn {
  /** Currently selected agent (null = Global Assistant mode) */
  selectedAgent: SidebarAgentInfo | null;
  /** Current conversation ID for the selected agent */
  conversationId: string | null;
  /** Whether the agent conversation is initialized */
  isInitialized: boolean;
  /** Select an agent (or null to return to Global Assistant) */
  selectAgent: (agent: SidebarAgentInfo | null) => void;
  /** Create a new conversation for the current agent */
  createNewConversation: () => Promise<string | null>;
  /** Refresh the current agent conversation (reload messages from server into the cache) */
  refreshConversation: () => Promise<void>;
  /** Load a specific conversation by ID */
  loadConversation: (conversationId: string) => Promise<void>;
}

/**
 * Hook for managing sidebar agent selection state.
 * Uses Zustand store internally for shared state across components.
 *
 * Messages are NOT held here (PR 5B, leaf 5.3): every loader commits to the
 * shared conversation cache (`loadAgentConversationMessages`), and surfaces
 * render via the `useRenderedMessages`/`useConversationLoadState` facades.
 */
export function usePageAgentSidebarState(): UseSidebarAgentStateReturn {
  const selectedAgent = useSidebarAgentStore((state) => state.selectedAgent);
  const conversationId = useSidebarAgentStore((state) => state.conversationId);
  const isInitialized = useSidebarAgentStore((state) => state.isInitialized);

  const selectAgent = useSidebarAgentStore((state) => state.selectAgent);

  // Ref to track which agent we're currently loading (for race condition protection)
  const loadingAgentIdRef = useRef<string | null>(null);

  // ============================================
  // Load/create conversation when agent is selected
  // ============================================
  useEffect(() => {
    const loadOrCreateConversation = async () => {
      if (!selectedAgent) {
        // No agent selected (global mode) - nothing to load
        loadingAgentIdRef.current = null;
        return;
      }

      const { isInitialized: alreadyInitialized, agentIdForConversation } = useSidebarAgentStore.getState();
      // If already initialized for this agent, skip
      if (alreadyInitialized && agentIdForConversation === selectedAgent.id) {
        return;
      }

      // Track which agent we're loading for (race condition protection)
      const currentAgentId = selectedAgent.id;
      loadingAgentIdRef.current = currentAgentId;

      const { applyIdentity } = useSidebarAgentStore.getState();
      applyIdentity({ type: 'RESOLVE_STARTED' });

      // Try to load most recent conversation
      try {
        const mostRecent = await fetchMostRecentAgentConversation(selectedAgent.id);

        // Abort if agent changed during fetch
        if (loadingAgentIdRef.current !== currentAgentId) return;

        if (mostRecent) {
          const resolved = useSidebarAgentStore.getState().applyIdentity({ type: 'RESOLVED', conversationId: mostRecent.id });
          // A newer identity (set via loadConversation/createNewConversation
          // while this was in flight) wins — don't load for the stale id.
          if (conversationIdFrom(resolved) !== mostRecent.id) return;
          useSidebarAgentStore.getState().markConversationLoaded(selectedAgent.id);
          await loadAgentConversationMessages(selectedAgent.id, mostRecent.id);
          return;
        }
      } catch (error) {
        // Abort if agent changed during error handling
        if (loadingAgentIdRef.current !== currentAgentId) return;
        console.error('Failed to load recent agent conversation:', error);
      }

      // Abort if agent changed before creating new conversation
      if (loadingAgentIdRef.current !== currentAgentId) return;

      // No existing conversation - create one. Only fall back to create if
      // nothing else has resolved identity while the fetches above were in
      // flight (createNewConversation's IDENTITY_SET always wins, so calling
      // it unconditionally here could clobber a newer user-triggered switch).
      if (!isResolving(useSidebarAgentStore.getState().identity)) return;

      const newConversationId = createId();
      const resolved = useSidebarAgentStore.getState().applyIdentity({ type: 'IDENTITY_SET', conversationId: newConversationId });
      if (conversationIdFrom(resolved) !== newConversationId) return;
      useSidebarAgentStore.getState().markConversationLoaded(selectedAgent.id);
      conversationMessagesActions.seedConversation(newConversationId);

      try {
        await createAgentConversation(selectedAgent.id, newConversationId);
      } catch (error) {
        if (loadingAgentIdRef.current !== currentAgentId) return;
        console.error('Failed to create new agent conversation:', error);
        toast.error('Failed to initialize agent conversation');
      }
    };

    loadOrCreateConversation();
  }, [selectedAgent]);

  // ============================================
  // Action: Create New Conversation
  // ============================================
  // The id is generated client-side (cuid2) and set synchronously — the
  // persist POST below is fire-and-forget, not the mechanism used to learn
  // the id. Closes the race where a send fired right after "New Chat" would
  // carry a stale conversationId.
  const createNewConversation = useCallback(async (): Promise<string | null> => {
    if (!selectedAgent) return null;

    const newConversationId = createId();
    useSidebarAgentStore.getState().applyIdentity({ type: 'IDENTITY_SET', conversationId: newConversationId });
    useSidebarAgentStore.getState().markConversationLoaded(selectedAgent.id);
    conversationMessagesActions.seedConversation(newConversationId);

    try {
      await createAgentConversation(selectedAgent.id, newConversationId);
    } catch (error) {
      console.error('Failed to create new conversation:', error);
      toast.error('Failed to create new conversation');
    }
    return newConversationId;
  }, [selectedAgent]);

  // ============================================
  // Action: Refresh Conversation
  // ============================================
  const refreshConversation = useCallback(async (): Promise<void> => {
    const currentConversationId = useSidebarAgentStore.getState().conversationId;
    if (!selectedAgent || !currentConversationId) return;
    await loadAgentConversationMessages(selectedAgent.id, currentConversationId);
  }, [selectedAgent]);

  // ============================================
  // Action: Load Specific Conversation
  // ============================================
  // The id is already known (it came from a history list) — adopt it
  // synchronously, before the messages fetch even starts, closing the race
  // where a send fired right after selecting a conversation could land under
  // the previous one. The cache loader's loadGeneration gate replaces the
  // local stale-result check.
  const loadConversation = useCallback(async (targetConversationId: string): Promise<void> => {
    if (!selectedAgent) return;

    useSidebarAgentStore.getState().applyIdentity({ type: 'IDENTITY_SET', conversationId: targetConversationId });
    useSidebarAgentStore.getState().markConversationLoaded(selectedAgent.id);
    await loadAgentConversationMessages(selectedAgent.id, targetConversationId);
  }, [selectedAgent]);

  // ============================================
  // Return hook interface
  // ============================================
  return {
    selectedAgent,
    conversationId,
    isInitialized,
    selectAgent,
    createNewConversation,
    refreshConversation,
    loadConversation,
  };
}
