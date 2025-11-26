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
  // Shared chat configuration for creating Chat instances
  // Each component creates its own Chat instance with this config
  chatConfig: {
    id: string | undefined;
    messages: UIMessage[];
    transport: DefaultChatTransport<UIMessage>;
    onError: (error: Error) => void;
  } | null;

  // Global message state - shared across all views
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;

  // Global streaming status - tracks if ANY view is streaming
  isStreaming: boolean;
  setIsStreaming: (streaming: boolean) => void;

  // Global stop function - allows ANY view to stop the stream
  stopStreaming: (() => void) | null;
  setStopStreaming: (fn: (() => void) | null) => void;

  // Current conversation state
  currentConversationId: string | null;
  initialMessages: UIMessage[];
  isInitialized: boolean;

  // Methods to manage conversation state
  setCurrentConversationId: (id: string | null) => void;
  loadConversation: (id: string) => Promise<void>;
  createNewConversation: () => Promise<void>;
  refreshConversation: () => Promise<void>;

  // Agent selection state
  selectedAgent: AgentInfo | null;  // null = Global Assistant
  setSelectedAgent: (agent: AgentInfo | null) => void;
  chatMode: 'global' | 'agent';

  // Agent-specific methods
  loadAgentConversation: (agentId: string, conversationId?: string) => Promise<void>;
  createAgentConversation: (agentId: string) => Promise<void>;
  selectAgent: (agent: AgentInfo | null) => Promise<void>;
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
   * Load a conversation for a specific agent
   * If no conversationId provided, loads the most recent or creates new
   */
  const loadAgentConversation = useCallback(async (agentId: string, conversationId?: string) => {
    try {
      setIsInitialized(false);

      let targetConversationId = conversationId;

      // If no conversationId, fetch the latest conversation for this agent
      if (!targetConversationId) {
        const latestResponse = await fetchWithAuth(`/api/agents/${agentId}/conversations/latest`);
        if (latestResponse.ok) {
          const latestConversation = await latestResponse.json();
          targetConversationId = latestConversation.id;
        }
      }

      if (!targetConversationId) {
        // No conversation exists, create one
        await createAgentConversation(agentId);
        return;
      }

      // Fetch messages for this conversation
      const messagesResponse = await fetchWithAuth(
        `/api/agents/${agentId}/conversations/${targetConversationId}/messages?limit=50`
      );

      if (messagesResponse.ok) {
        const messageData = await messagesResponse.json();
        const loadedMessages = Array.isArray(messageData) ? messageData : messageData.messages || [];

        setInitialMessages(loadedMessages);
        setMessages(loadedMessages);
        setCurrentConversationId(targetConversationId);
        conversationState.setActiveConversationId(targetConversationId);
        conversationState.setActiveAgentId(agentId);

        // Update URL to reflect agent and conversation
        const url = new URL(window.location.href);
        url.searchParams.set('agent', agentId);
        url.searchParams.set('c', targetConversationId);
        window.history.pushState({}, '', url.toString());

        setIsInitialized(true);
      } else {
        console.error('Failed to load agent conversation:', targetConversationId);
        setIsInitialized(true);
      }
    } catch (error) {
      console.error('Error loading agent conversation:', error);
      setInitialMessages([]);
      setMessages([]);
      setIsInitialized(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Create a new conversation for a specific agent
   */
  const createAgentConversation = useCallback(async (agentId: string) => {
    try {
      const response = await fetchWithAuth(`/api/agents/${agentId}/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (response.ok) {
        const newConversation = await response.json();
        setCurrentConversationId(newConversation.conversationId);
        setInitialMessages([]);
        setMessages([]);
        conversationState.setActiveConversationId(newConversation.conversationId);
        conversationState.setActiveAgentId(agentId);

        // Update URL to reflect agent and new conversation
        const url = new URL(window.location.href);
        url.searchParams.set('agent', agentId);
        url.searchParams.set('c', newConversation.conversationId);
        window.history.pushState({}, '', url.toString());

        setIsInitialized(true);
      } else {
        console.error('Failed to create agent conversation');
      }
    } catch (error) {
      console.error('Error creating agent conversation:', error);
    }
  }, []);

  /**
   * Select an agent (or null for Global Assistant) and load their conversation
   * Handles all state transitions including stopping streams and loading history
   */
  const selectAgent = useCallback(async (agent: AgentInfo | null) => {
    // Stop any active streaming before switching
    if (stopStreaming) {
      stopStreaming();
      setStopStreaming(null);
    }

    setSelectedAgent(agent);

    if (agent) {
      // Switching to a specific agent
      await loadAgentConversation(agent.id);
    } else {
      // Switching back to Global Assistant
      conversationState.setActiveAgentId(null);

      // Clear agent from URL
      const url = new URL(window.location.href);
      url.searchParams.delete('agent');

      // Try to load the most recent global conversation
      const response = await fetchWithAuth('/api/ai_conversations/global');
      if (response.ok) {
        const conversation = await response.json();
        if (conversation && conversation.id) {
          await loadConversation(conversation.id);
          url.searchParams.set('c', conversation.id);
          window.history.pushState({}, '', url.toString());
          return;
        }
      }

      // No global conversation - create one
      await createNewConversation();
    }
  }, [stopStreaming, loadAgentConversation, loadConversation, createNewConversation]);

  /**
   * Initialize chat on mount
   * Detects agent context from URL/cookies and loads appropriate conversation
   */
  useEffect(() => {
    const initializeGlobalChat = async () => {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const urlAgentId = urlParams.get('agent');
        const urlConversationId = urlParams.get('c');
        const cookieAgentId = conversationState.getActiveAgentId();
        const cookieConversationId = conversationState.getActiveConversationId();

        // Determine if we're in agent mode
        const agentId = urlAgentId || cookieAgentId;

        if (agentId) {
          // AGENT MODE: Restore agent state and load agent conversation

          // Fetch agent info to restore selectedAgent state
          const agentsResponse = await fetchWithAuth('/api/agents/multi-drive?groupByDrive=true');
          if (agentsResponse.ok) {
            const agentsData = await agentsResponse.json();
            const allAgents = agentsData.agentsByDrive?.flatMap((d: { agents: unknown[] }) => d.agents) || [];
            const agent = allAgents.find((a: { id: string }) => a.id === agentId);

            if (agent) {
              // Restore agent selection
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

              // Load agent conversation (with optional specific conversation ID)
              const conversationId = urlConversationId || cookieConversationId;
              await loadAgentConversation(agentId, conversationId || undefined);
              return;
            }
          }

          // Agent not found - clear stale agent cookie and fall through to global
          conversationState.setActiveAgentId(null);
        }

        // GLOBAL MODE: Existing logic
        if (urlConversationId) {
          await loadConversation(urlConversationId);
          return;
        }

        if (cookieConversationId) {
          await loadConversation(cookieConversationId);
          return;
        }

        // Try to get the most recent global conversation
        const response = await fetchWithAuth('/api/ai_conversations/global');
        if (response.ok) {
          const conversation = await response.json();
          if (conversation && conversation.id) {
            await loadConversation(conversation.id);

            // Update URL to reflect the conversation
            const url = new URL(window.location.href);
            url.searchParams.set('c', conversation.id);
            window.history.replaceState({}, '', url.toString());
            return;
          }
        }

        // No existing conversation - create first one
        await createNewConversation();
      } catch (error) {
        console.error('Failed to initialize global chat:', error);
        setIsInitialized(true);
      }
    };

    initializeGlobalChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount

  // Create stable chat config that components can use to create their own Chat instances
  // Each component creates its own independent Chat instance
  // Config is stable - only changes when conversation changes, not during streaming
  // This prevents re-initialization which would abort ongoing streams
  const chatConfig = useMemo(() => {
    if (!currentConversationId) return null;

    // Determine the API endpoint based on whether we're in agent mode
    const apiEndpoint = selectedAgent
      ? `/api/agents/${selectedAgent.id}/conversations/${currentConversationId}/messages`
      : `/api/ai_conversations/${currentConversationId}/messages`;

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
  }, [currentConversationId, initialMessages, selectedAgent]);

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
    // Agent selection state
    selectedAgent,
    setSelectedAgent,
    chatMode,
    // Agent-specific methods
    loadAgentConversation,
    createAgentConversation,
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
    loadAgentConversation,
    createAgentConversation,
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
