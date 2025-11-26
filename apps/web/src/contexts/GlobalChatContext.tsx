'use client';

import React, { createContext, useContext, ReactNode, useState, useCallback, useEffect, useMemo } from 'react';
import { DefaultChatTransport, UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { conversationState } from '@/lib/ai/conversation-state';

/**
 * Agent information for the selected agent
 * null = Global Assistant mode
 */
export interface AgentInfo {
  id: string;
  title: string;
  driveId: string;
  driveName: string;
  systemPrompt?: string;
  aiProvider?: string;
  aiModel?: string;
  enabledTools?: string[];
}

interface GlobalChatContextValue {
  // Chat configuration for GLOBAL ASSISTANT mode only
  // When agent is selected, GlobalAssistantView uses its own local config
  chatConfig: {
    id: string | undefined;
    messages: UIMessage[];
    transport: DefaultChatTransport<UIMessage>;
    onError: (error: Error) => void;
  } | null;

  // Global message state - for GLOBAL ASSISTANT mode
  // Shared across sidebar and middle view when in global mode
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;

  // Global streaming status - for GLOBAL ASSISTANT mode
  isStreaming: boolean;
  setIsStreaming: (streaming: boolean) => void;

  // Global stop function - for GLOBAL ASSISTANT mode
  stopStreaming: (() => void) | null;
  setStopStreaming: (fn: (() => void) | null) => void;

  // Current conversation state - for GLOBAL ASSISTANT mode
  currentConversationId: string | null;
  initialMessages: UIMessage[];
  isInitialized: boolean;

  // Methods to manage GLOBAL conversation state
  setCurrentConversationId: (id: string | null) => void;
  loadConversation: (id: string) => Promise<void>;
  createNewConversation: () => Promise<void>;
  refreshConversation: () => Promise<void>;

  // Agent selection state (UI state shared across app)
  // When selectedAgent is set, GlobalAssistantView uses LOCAL state for agent chat
  // This context continues to manage GLOBAL ASSISTANT state for the sidebar
  selectedAgent: AgentInfo | null;  // null = Global Assistant
  setSelectedAgent: (agent: AgentInfo | null) => void;
  chatMode: 'global' | 'agent';

  // Agent selection method - just sets the agent, no conversation loading
  // GlobalAssistantView handles agent conversation loading locally
  selectAgent: (agent: AgentInfo | null) => void;
}

const GlobalChatContext = createContext<GlobalChatContextValue | undefined>(undefined);

export function GlobalChatProvider({ children }: { children: ReactNode }) {
  // Conversation management state
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [isInitialized, setIsInitialized] = useState<boolean>(false);

  // Global message state - THE single source of truth for messages
  // Both views sync to and render from this state
  const [messages, setMessages] = useState<UIMessage[]>([]);

  // Global streaming status - tracks if ANY view is streaming
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

  // Global stop function - allows ANY view to stop the active stream
  const [stopStreaming, setStopStreaming] = useState<(() => void) | null>(null);

  // Agent selection state - null means Global Assistant
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);

  // Derived chat mode
  const chatMode: 'global' | 'agent' = selectedAgent ? 'agent' : 'global';

  /**
   * Load a conversation by ID
   * This fetches messages and updates the chat config
   */
  const loadConversation = useCallback(async (conversationId: string) => {
    try {
      setIsInitialized(false);

      // Fetch messages for this conversation
      const messagesResponse = await fetchWithAuth(
        `/api/ai_conversations/${conversationId}/messages?limit=50`
      );

      if (messagesResponse.ok) {
        const messageData = await messagesResponse.json();
        // Handle both old format (array) and new format (object with messages and pagination)
        const loadedMessages = Array.isArray(messageData) ? messageData : messageData.messages || [];

        setInitialMessages(loadedMessages);
        setMessages(loadedMessages); // Initialize global messages
        setCurrentConversationId(conversationId);
        conversationState.setActiveConversationId(conversationId);

        setIsInitialized(true);
      } else {
        console.error('Failed to load conversation:', conversationId);
        setIsInitialized(true);
      }
    } catch (error) {
      console.error('Error loading conversation:', error);
      setInitialMessages([]);
      setMessages([]); // Clear global messages on error
      setIsInitialized(true);
    }
  }, []);

  /**
   * Create a new global conversation
   */
  const createNewConversation = useCallback(async () => {
    try {
      const newConversation = await conversationState.createAndSetActiveConversation({
        type: 'global',
      });

      if (newConversation && newConversation.id) {
        setCurrentConversationId(newConversation.id);
        setInitialMessages([]);
        setMessages([]); // Clear global messages for new conversation
        conversationState.setActiveConversationId(newConversation.id);

        // Update URL to reflect new conversation
        const url = new URL(window.location.href);
        url.searchParams.set('c', newConversation.id);
        window.history.pushState({}, '', url.toString());

        setIsInitialized(true);
      }
    } catch (error) {
      console.error('Failed to create new conversation:', error);
    }
  }, []);

  /**
   * Refresh the current conversation (re-fetch messages)
   */
  const refreshConversation = useCallback(async () => {
    if (currentConversationId) {
      await loadConversation(currentConversationId);
    }
  }, [currentConversationId, loadConversation]);

  /**
   * Select an agent (or null for Global Assistant)
   * This just sets the agent selection state.
   * GlobalAssistantView handles agent conversation loading locally.
   * When switching back to global, ensures global conversation is ready.
   */
  const selectAgent = useCallback((agent: AgentInfo | null) => {
    // Stop any active global streaming before switching
    if (stopStreaming) {
      stopStreaming();
      setStopStreaming(null);
    }

    setSelectedAgent(agent);

    if (agent) {
      // Switching to agent mode
      // GlobalAssistantView will handle loading agent conversation locally
      conversationState.setActiveAgentId(agent.id);
    } else {
      // Switching back to Global Assistant
      conversationState.setActiveAgentId(null);

      // Clear agent from URL
      const url = new URL(window.location.href);
      url.searchParams.delete('agent');
      window.history.pushState({}, '', url.toString());

      // Global conversation should already be initialized from mount
      // If not, the useEffect will handle it
    }
  }, [stopStreaming]);

  /**
   * Initialize GLOBAL ASSISTANT chat on mount
   * Only initializes Global Assistant state - agent mode is handled by GlobalAssistantView locally
   * Also restores selectedAgent UI state if agent was previously selected
   */
  useEffect(() => {
    const initializeGlobalChat = async () => {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const urlAgentId = urlParams.get('agent');
        const urlConversationId = urlParams.get('c');
        const cookieAgentId = conversationState.getActiveAgentId();
        const cookieConversationId = conversationState.getActiveConversationId();

        // Restore agent selection UI state if needed (but don't load agent conversation)
        const agentId = urlAgentId || cookieAgentId;
        if (agentId) {
          // Fetch agent info to restore selectedAgent UI state
          const agentsResponse = await fetchWithAuth('/api/agents/multi-drive?groupByDrive=true');
          if (agentsResponse.ok) {
            const agentsData = await agentsResponse.json();
            const allAgents = agentsData.agentsByDrive?.flatMap((d: { agents: unknown[] }) => d.agents) || [];
            const agent = allAgents.find((a: { id: string }) => a.id === agentId);

            if (agent) {
              // Restore agent selection UI state
              // GlobalAssistantView will handle loading agent conversation locally
              setSelectedAgent({
                id: agent.id,
                title: agent.title || 'Unnamed Agent',
                driveId: agent.driveId,
                driveName: agent.driveName,
                systemPrompt: agent.systemPrompt,
                aiProvider: agent.aiProvider,
                aiModel: agent.aiModel,
                enabledTools: agent.enabledTools,
              });
            } else {
              // Agent not found - clear stale agent cookie
              conversationState.setActiveAgentId(null);
            }
          }
        }

        // Always initialize GLOBAL conversation state (for sidebar to use)
        // When agent is selected, GlobalAssistantView manages agent chat separately
        const globalConversationId = agentId ? cookieConversationId : (urlConversationId || cookieConversationId);

        if (globalConversationId && !agentId) {
          // Only load if not in agent mode - URL conversation is for agent
          await loadConversation(globalConversationId);
          return;
        }

        // Try to get the most recent global conversation
        const response = await fetchWithAuth('/api/ai_conversations/global');
        if (response.ok) {
          const conversation = await response.json();
          if (conversation && conversation.id) {
            await loadConversation(conversation.id);

            // Update URL only if not in agent mode
            if (!agentId) {
              const url = new URL(window.location.href);
              url.searchParams.set('c', conversation.id);
              window.history.replaceState({}, '', url.toString());
            }
            return;
          }
        }

        // No existing global conversation - create one
        await createNewConversation();
      } catch (error) {
        console.error('Failed to initialize global chat:', error);
        setIsInitialized(true);
      }
    };

    initializeGlobalChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount

  // Create stable chat config for GLOBAL ASSISTANT mode only
  // This config is used by AssistantChatTab (sidebar) and GlobalAssistantView when no agent selected
  // When agent is selected, GlobalAssistantView uses its own local config
  const chatConfig = useMemo(() => {
    if (!currentConversationId) return null;

    // Global Assistant API endpoint - always for global conversations
    const apiEndpoint = `/api/ai_conversations/${currentConversationId}/messages`;

    return {
      id: currentConversationId,
      messages: initialMessages, // Stable - only updates on conversation load
      transport: new DefaultChatTransport({
        api: apiEndpoint,
        fetch: (url, options) => {
          const urlString = url instanceof Request ? url.url : url.toString();
          return fetchWithAuth(urlString, options);
        },
      }),
      onError: (error: Error) => {
        console.error('❌ Global Chat Error:', error);
        if (error.message?.includes('Unauthorized') || error.message?.includes('401')) {
          console.error('🔒 Authentication failed - user may need to log in again');
        }
      },
    };
  }, [currentConversationId, initialMessages]);

  // Context value with memoization - prevents SWR revalidation loops and unnecessary re-renders
  // Functions are already stable via useCallback
  const contextValue: GlobalChatContextValue = useMemo(() => ({
    chatConfig,
    messages,
    setMessages,
    isStreaming,
    setIsStreaming,
    stopStreaming,
    setStopStreaming,
    currentConversationId,
    initialMessages,
    isInitialized,
    setCurrentConversationId,
    loadConversation,
    createNewConversation,
    refreshConversation,
    // Agent selection state (UI only - agent conversation loading is handled locally)
    selectedAgent,
    setSelectedAgent,
    chatMode,
    selectAgent,
  }), [
    chatConfig,
    messages,
    isStreaming,
    stopStreaming,
    currentConversationId,
    initialMessages,
    isInitialized,
    loadConversation,
    createNewConversation,
    refreshConversation,
    selectedAgent,
    chatMode,
    selectAgent,
  ]);

  return (
    <GlobalChatContext.Provider value={contextValue}>
      {children}
    </GlobalChatContext.Provider>
  );
}

/**
 * Hook to access the shared global chat context
 * Throws error if used outside of GlobalChatProvider
 */
export function useGlobalChat() {
  const context = useContext(GlobalChatContext);
  if (!context) {
    throw new Error('useGlobalChat must be used within a GlobalChatProvider');
  }
  return context;
}
