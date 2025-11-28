import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import { AgentInfo, isValidAgentInfo } from '@/types/agent';

/**
 * SidebarAgentInfo is now an alias for the shared AgentInfo type.
 * Kept for backward compatibility with existing code.
 */
export type SidebarAgentInfo = AgentInfo;

// ============================================
// Zustand Store
// ============================================

interface SidebarAgentStoreState {
  // Agent selection
  selectedAgent: SidebarAgentInfo | null;

  // Conversation state
  conversationId: string | null;
  initialMessages: UIMessage[];
  isInitialized: boolean;
  agentIdForConversation: string | null;

  // Internal state for race condition protection (not persisted)
  _loadingAgentId: string | null;

  // Actions
  selectAgent: (agent: SidebarAgentInfo | null) => void;
  setConversationLoading: () => void;
  setConversationLoaded: (conversationId: string, messages: UIMessage[], agentId: string) => void;
  setConversationCreated: (conversationId: string, agentId: string) => void;
  setConversationError: (agentId: string) => void;
  updateMessages: (messages: UIMessage[]) => void;
  setLoadingAgentId: (agentId: string | null) => void;
}

export const useSidebarAgentStore = create<SidebarAgentStoreState>()(
  persist(
    (set) => ({
      // Initial state
      selectedAgent: null,
      conversationId: null,
      initialMessages: [],
      isInitialized: false,
      agentIdForConversation: null,
      _loadingAgentId: null,

      // Actions
      selectAgent: (agent) => {
        set((state) => {
          // When selecting a new agent (or null for global), reset conversation state
          if (agent?.id !== state.selectedAgent?.id) {
            return {
              selectedAgent: agent,
              conversationId: null,
              initialMessages: [],
              isInitialized: false,
              agentIdForConversation: null,
            };
          }
          return { selectedAgent: agent };
        });
      },

      setConversationLoading: () => {
        set({ isInitialized: false });
      },

      setConversationLoaded: (conversationId, messages, agentId) => {
        set({
          conversationId,
          initialMessages: messages,
          isInitialized: true,
          agentIdForConversation: agentId,
        });
      },

      setConversationCreated: (conversationId, agentId) => {
        set({
          conversationId,
          initialMessages: [],
          isInitialized: true,
          agentIdForConversation: agentId,
        });
      },

      setConversationError: (agentId) => {
        set({
          isInitialized: true, // Allow UI to recover
          agentIdForConversation: agentId,
        });
      },

      updateMessages: (messages) => {
        set({ initialMessages: messages });
      },

      setLoadingAgentId: (agentId) => {
        set({ _loadingAgentId: agentId });
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
  /** Initial messages for the agent conversation */
  initialMessages: UIMessage[];
  /** Whether the agent conversation is initialized */
  isInitialized: boolean;
  /** Select an agent (or null to return to Global Assistant) */
  selectAgent: (agent: SidebarAgentInfo | null) => void;
  /** Create a new conversation for the current agent */
  createNewConversation: () => Promise<string | null>;
  /** Refresh the current agent conversation (reload messages from server) */
  refreshConversation: () => Promise<void>;
  /** Update messages (for optimistic UI updates) */
  updateMessages: (messages: UIMessage[]) => void;
}

/**
 * Hook for managing sidebar agent selection state.
 * Uses Zustand store internally for shared state across components.
 */
export function usePageAgentSidebarState(): UseSidebarAgentStateReturn {
  const store = useSidebarAgentStore();

  // Destructure store methods for useEffect dependencies (stable references from Zustand)
  const {
    selectedAgent,
    isInitialized,
    agentIdForConversation,
    setConversationLoading,
    setConversationLoaded,
    setConversationCreated,
    setConversationError,
  } = store;

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

      // If already initialized for this agent, skip
      if (isInitialized && agentIdForConversation === selectedAgent.id) {
        return;
      }

      // Track which agent we're loading for (race condition protection)
      const currentAgentId = selectedAgent.id;
      loadingAgentIdRef.current = currentAgentId;

      setConversationLoading();

      // Try to load most recent conversation
      try {
        const response = await fetchWithAuth(
          `/api/ai/page-agents/${selectedAgent.id}/conversations?limit=1`
        );

        // Abort if agent changed during fetch
        if (loadingAgentIdRef.current !== currentAgentId) return;

        if (response.ok) {
          const data = await response.json();
          if (data.conversations && data.conversations.length > 0) {
            const mostRecent = data.conversations[0];
            // Load messages
            const messagesResponse = await fetchWithAuth(
              `/api/ai/page-agents/${selectedAgent.id}/conversations/${mostRecent.id}/messages`
            );

            // Abort if agent changed during fetch
            if (loadingAgentIdRef.current !== currentAgentId) return;

            if (messagesResponse.ok) {
              const messagesData = await messagesResponse.json();
              setConversationLoaded(
                mostRecent.id,
                messagesData.messages || [],
                selectedAgent.id
              );
              return;
            }
          }
        }
      } catch (error) {
        // Abort if agent changed during error handling
        if (loadingAgentIdRef.current !== currentAgentId) return;
        console.error('Failed to load recent agent conversation:', error);
      }

      // Abort if agent changed before creating new conversation
      if (loadingAgentIdRef.current !== currentAgentId) return;

      // No existing conversation - create new one
      try {
        const response = await fetchWithAuth(
          `/api/ai/page-agents/${selectedAgent.id}/conversations`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }
        );

        // Abort if agent changed during fetch
        if (loadingAgentIdRef.current !== currentAgentId) return;

        if (response.ok) {
          const data = await response.json();
          const newConversationId = data.conversationId || data.id;
          setConversationCreated(newConversationId, selectedAgent.id);
        } else {
          throw new Error('Failed to create conversation');
        }
      } catch (error) {
        // Abort if agent changed during error handling
        if (loadingAgentIdRef.current !== currentAgentId) return;
        console.error('Failed to create new agent conversation:', error);
        toast.error('Failed to initialize agent conversation');
        setConversationError(selectedAgent.id);
      }
    };

    loadOrCreateConversation();
  }, [
    selectedAgent,
    isInitialized,
    agentIdForConversation,
    setConversationLoading,
    setConversationLoaded,
    setConversationCreated,
    setConversationError,
  ]);

  // ============================================
  // Action: Create New Conversation
  // ============================================
  const createNewConversation = async (): Promise<string | null> => {
    const agent = store.selectedAgent;
    if (!agent) return null;

    try {
      const response = await fetchWithAuth(
        `/api/ai/page-agents/${agent.id}/conversations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      if (response.ok) {
        const data = await response.json();
        const newConversationId = data.conversationId || data.id;
        store.setConversationCreated(newConversationId, agent.id);
        return newConversationId;
      }
    } catch (error) {
      console.error('Failed to create new conversation:', error);
      toast.error('Failed to create new conversation');
    }
    return null;
  };

  // ============================================
  // Action: Refresh Conversation
  // ============================================
  const refreshConversation = async (): Promise<void> => {
    const agent = store.selectedAgent;
    const conversationId = store.conversationId;
    if (!agent || !conversationId) return;

    try {
      const response = await fetchWithAuth(
        `/api/ai/page-agents/${agent.id}/conversations/${conversationId}/messages`
      );
      if (response.ok) {
        const data = await response.json();
        store.updateMessages(data.messages || []);
      }
    } catch (error) {
      console.error('Failed to refresh agent conversation:', error);
    }
  };

  // ============================================
  // Return hook interface
  // ============================================
  return {
    selectedAgent: store.selectedAgent,
    conversationId: store.conversationId,
    initialMessages: store.initialMessages,
    isInitialized: store.isInitialized,
    selectAgent: store.selectAgent,
    createNewConversation,
    refreshConversation,
    updateMessages: store.updateMessages,
  };
}
