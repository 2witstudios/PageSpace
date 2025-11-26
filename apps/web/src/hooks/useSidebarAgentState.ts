import { useReducer, useEffect, useCallback, useMemo, useRef } from 'react';
import { UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { toast } from 'sonner';

/**
 * Agent information for sidebar selection.
 * Matches the AgentInfo type from useAgentStore but kept separate
 * to avoid coupling sidebar state to the middle panel's store.
 */
export interface SidebarAgentInfo {
  id: string;
  title: string;
  driveId: string;
  driveName: string;
  systemPrompt?: string;
  aiProvider?: string;
  aiModel?: string;
  enabledTools?: string[];
}

// ============================================
// Type Guards for localStorage validation
// ============================================

function isValidAgentInfo(data: unknown): data is SidebarAgentInfo {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.title === 'string' &&
    typeof obj.driveId === 'string' &&
    typeof obj.driveName === 'string'
  );
}

// ============================================
// State and Actions
// ============================================

interface AgentConversationState {
  conversationId: string | null;
  initialMessages: UIMessage[];
  isInitialized: boolean;
  /** Tracks which agent the current conversation belongs to */
  agentIdForConversation: string | null;
}

interface SidebarAgentFullState {
  selectedAgent: SidebarAgentInfo | null;
  conversation: AgentConversationState;
}

type AgentStateAction =
  | { type: 'SELECT_AGENT'; agent: SidebarAgentInfo | null }
  | { type: 'CONVERSATION_LOADING' }
  | { type: 'CONVERSATION_LOADED'; conversationId: string; messages: UIMessage[]; agentId: string }
  | { type: 'CONVERSATION_CREATED'; conversationId: string; agentId: string }
  | { type: 'CONVERSATION_ERROR'; agentId: string }
  | { type: 'RESET_CONVERSATION' }
  | { type: 'UPDATE_MESSAGES'; messages: UIMessage[] };

const initialConversationState: AgentConversationState = {
  conversationId: null,
  initialMessages: [],
  isInitialized: false,
  agentIdForConversation: null,
};

const initialState: SidebarAgentFullState = {
  selectedAgent: null,
  conversation: initialConversationState,
};

function agentStateReducer(
  state: SidebarAgentFullState,
  action: AgentStateAction
): SidebarAgentFullState {
  switch (action.type) {
    case 'SELECT_AGENT':
      // When selecting a new agent (or null for global), reset conversation state
      if (action.agent?.id !== state.selectedAgent?.id) {
        return {
          selectedAgent: action.agent,
          conversation: initialConversationState,
        };
      }
      return { ...state, selectedAgent: action.agent };

    case 'CONVERSATION_LOADING':
      return {
        ...state,
        conversation: {
          ...state.conversation,
          isInitialized: false,
        },
      };

    case 'CONVERSATION_LOADED':
      return {
        ...state,
        conversation: {
          conversationId: action.conversationId,
          initialMessages: action.messages,
          isInitialized: true,
          agentIdForConversation: action.agentId,
        },
      };

    case 'CONVERSATION_CREATED':
      return {
        ...state,
        conversation: {
          conversationId: action.conversationId,
          initialMessages: [],
          isInitialized: true,
          agentIdForConversation: action.agentId,
        },
      };

    case 'CONVERSATION_ERROR':
      return {
        ...state,
        conversation: {
          ...state.conversation,
          isInitialized: true, // Allow UI to recover
          agentIdForConversation: action.agentId,
        },
      };

    case 'RESET_CONVERSATION':
      return {
        ...state,
        conversation: initialConversationState,
      };

    case 'UPDATE_MESSAGES':
      return {
        ...state,
        conversation: {
          ...state.conversation,
          initialMessages: action.messages,
        },
      };

    default:
      return state;
  }
}

// ============================================
// localStorage Keys
// ============================================

const STORAGE_KEY_AGENT_DATA = 'pagespace:sidebar:selectedAgentData';

// ============================================
// Hook
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

export function useSidebarAgentState(): UseSidebarAgentStateReturn {
  const [state, dispatch] = useReducer(agentStateReducer, initialState);

  // Ref to track which agent we're currently loading conversation for (race condition protection)
  const loadingAgentIdRef = useRef<string | null>(null);

  // ============================================
  // Restore from localStorage on mount
  // ============================================
  useEffect(() => {
    try {
      const savedData = localStorage.getItem(STORAGE_KEY_AGENT_DATA);
      if (savedData) {
        const parsed = JSON.parse(savedData);
        if (isValidAgentInfo(parsed)) {
          dispatch({ type: 'SELECT_AGENT', agent: parsed });
        } else {
          // Invalid data, clean up
          localStorage.removeItem(STORAGE_KEY_AGENT_DATA);
        }
      }
    } catch {
      // Parse error, clean up
      localStorage.removeItem(STORAGE_KEY_AGENT_DATA);
    }
  }, []);

  // ============================================
  // Persist to localStorage when agent changes
  // ============================================
  useEffect(() => {
    if (state.selectedAgent) {
      localStorage.setItem(STORAGE_KEY_AGENT_DATA, JSON.stringify(state.selectedAgent));
    } else {
      localStorage.removeItem(STORAGE_KEY_AGENT_DATA);
    }
  }, [state.selectedAgent]);

  // ============================================
  // Load/create conversation when agent is selected
  // ============================================
  useEffect(() => {
    const loadOrCreateConversation = async () => {
      const agent = state.selectedAgent;

      if (!agent) {
        // No agent selected (global mode) - nothing to load
        loadingAgentIdRef.current = null;
        return;
      }

      // If already initialized for this agent, skip
      if (
        state.conversation.isInitialized &&
        state.conversation.agentIdForConversation === agent.id
      ) {
        return;
      }

      // Track which agent we're loading for (race condition protection)
      const currentAgentId = agent.id;
      loadingAgentIdRef.current = currentAgentId;

      dispatch({ type: 'CONVERSATION_LOADING' });

      // Try to load most recent conversation
      try {
        const response = await fetchWithAuth(
          `/api/agents/${agent.id}/conversations?limit=1`
        );

        // Abort if agent changed during fetch
        if (loadingAgentIdRef.current !== currentAgentId) return;

        if (response.ok) {
          const data = await response.json();
          if (data.conversations && data.conversations.length > 0) {
            const mostRecent = data.conversations[0];
            // Load messages
            const messagesResponse = await fetchWithAuth(
              `/api/agents/${agent.id}/conversations/${mostRecent.id}/messages`
            );

            // Abort if agent changed during fetch
            if (loadingAgentIdRef.current !== currentAgentId) return;

            if (messagesResponse.ok) {
              const messagesData = await messagesResponse.json();
              dispatch({
                type: 'CONVERSATION_LOADED',
                conversationId: mostRecent.id,
                messages: messagesData.messages || [],
                agentId: agent.id,
              });
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
          `/api/agents/${agent.id}/conversations`,
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
          dispatch({
            type: 'CONVERSATION_CREATED',
            conversationId: newConversationId,
            agentId: agent.id,
          });
        } else {
          throw new Error('Failed to create conversation');
        }
      } catch (error) {
        // Abort if agent changed during error handling
        if (loadingAgentIdRef.current !== currentAgentId) return;
        console.error('Failed to create new agent conversation:', error);
        toast.error('Failed to initialize agent conversation');
        dispatch({ type: 'CONVERSATION_ERROR', agentId: agent.id });
      }
    };

    loadOrCreateConversation();
  }, [state.selectedAgent, state.conversation.isInitialized, state.conversation.agentIdForConversation]);

  // ============================================
  // Actions
  // ============================================

  const selectAgent = useCallback((agent: SidebarAgentInfo | null) => {
    dispatch({ type: 'SELECT_AGENT', agent });
  }, []);

  const createNewConversation = useCallback(async (): Promise<string | null> => {
    const agent = state.selectedAgent;
    if (!agent) return null;

    try {
      const response = await fetchWithAuth(
        `/api/agents/${agent.id}/conversations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      if (response.ok) {
        const data = await response.json();
        const newConversationId = data.conversationId || data.id;
        dispatch({
          type: 'CONVERSATION_CREATED',
          conversationId: newConversationId,
          agentId: agent.id,
        });
        return newConversationId;
      }
    } catch (error) {
      console.error('Failed to create new conversation:', error);
      toast.error('Failed to create new conversation');
    }
    return null;
  }, [state.selectedAgent]);

  const refreshConversation = useCallback(async () => {
    const agent = state.selectedAgent;
    const conversationId = state.conversation.conversationId;
    if (!agent || !conversationId) return;

    try {
      const response = await fetchWithAuth(
        `/api/agents/${agent.id}/conversations/${conversationId}/messages`
      );
      if (response.ok) {
        const data = await response.json();
        dispatch({ type: 'UPDATE_MESSAGES', messages: data.messages || [] });
      }
    } catch (error) {
      console.error('Failed to refresh agent conversation:', error);
    }
  }, [state.selectedAgent, state.conversation.conversationId]);

  const updateMessages = useCallback((messages: UIMessage[]) => {
    dispatch({ type: 'UPDATE_MESSAGES', messages });
  }, []);

  // ============================================
  // Return
  // ============================================

  return useMemo(() => ({
    selectedAgent: state.selectedAgent,
    conversationId: state.conversation.conversationId,
    initialMessages: state.conversation.initialMessages,
    isInitialized: state.conversation.isInitialized,
    selectAgent,
    createNewConversation,
    refreshConversation,
    updateMessages,
  }), [
    state.selectedAgent,
    state.conversation.conversationId,
    state.conversation.initialMessages,
    state.conversation.isInitialized,
    selectAgent,
    createNewConversation,
    refreshConversation,
    updateMessages,
  ]);
}
