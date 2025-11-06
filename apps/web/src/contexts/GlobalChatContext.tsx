'use client';

import React, { createContext, useContext, ReactNode, useState, useCallback, useEffect, useMemo } from 'react';
import { DefaultChatTransport, UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { conversationState } from '@/lib/ai/conversation-state';

interface AgentConfig {
  id: string;
  title: string | null;
  systemPrompt: string | null;
  enabledTools: string[];
  aiProvider: string;
  aiModel: string;
  driveId: string;
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

  // Agent mode state
  selectedAgent: AgentConfig | null;
  isAgentMode: boolean; // true if an agent is selected, false for default modes
  availableAgents: AgentConfig[];
  loadSelectedAgent: () => Promise<void>;
  setSelectedAgent: (agentId: string | null) => Promise<void>;
  loadAvailableAgents: () => Promise<void>;

  // Methods to manage conversation state
  setCurrentConversationId: (id: string | null) => void;
  loadConversation: (id: string) => Promise<void>;
  createNewConversation: () => Promise<void>;
  refreshConversation: () => Promise<void>;
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

  // Agent mode state
  const [selectedAgent, setSelectedAgentState] = useState<AgentConfig | null>(null);
  const [availableAgents, setAvailableAgents] = useState<AgentConfig[]>([]);

  // Computed: are we in agent mode?
  const isAgentMode = selectedAgent !== null;

  /**
   * Load the user's selected global agent from the API
   */
  const loadSelectedAgent = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/api/user/global-agent');
      if (response.ok) {
        const data = await response.json();
        if (data.selectedAgent) {
          setSelectedAgentState(data.selectedAgent);
        } else {
          setSelectedAgentState(null);
        }
      } else {
        console.error('Failed to load selected agent');
        setSelectedAgentState(null);
      }
    } catch (error) {
      console.error('Error loading selected agent:', error);
      setSelectedAgentState(null);
    }
  }, []);

  /**
   * Load all available agents the user has access to
   */
  const loadAvailableAgents = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/api/user/agents');
      if (response.ok) {
        const data = await response.json();
        setAvailableAgents(data.agents || []);
      } else {
        console.error('Failed to load available agents');
        setAvailableAgents([]);
      }
    } catch (error) {
      console.error('Error loading available agents:', error);
      setAvailableAgents([]);
    }
  }, []);

  /**
   * Set the user's selected global agent
   * Pass null to clear the selection
   */
  const setSelectedAgent = useCallback(async (agentId: string | null) => {
    try {
      const response = await fetchWithAuth('/api/user/global-agent', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      });

      if (response.ok) {
        const data = await response.json();
        setSelectedAgentState(data.selectedAgent);
      } else {
        console.error('Failed to set selected agent');
      }
    } catch (error) {
      console.error('Error setting selected agent:', error);
    }
  }, []);

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
        agentPageId: selectedAgent?.id || null, // Link to selected agent if any
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
  }, [selectedAgent]);

  /**
   * Refresh the current conversation (re-fetch messages)
   */
  const refreshConversation = useCallback(async () => {
    if (currentConversationId) {
      await loadConversation(currentConversationId);
    }
  }, [currentConversationId, loadConversation]);

  /**
   * Initialize with most recent global conversation on mount
   */
  useEffect(() => {
    const initializeGlobalChat = async () => {
      try {
        // Load selected agent first
        await loadSelectedAgent();

        // Check URL for conversation ID
        const urlParams = new URLSearchParams(window.location.search);
        const urlConversationId = urlParams.get('c');

        if (urlConversationId) {
          // URL has a conversation ID - load it
          await loadConversation(urlConversationId);
          return;
        }

        // Check cookie for active conversation
        const cookieConversationId = conversationState.getActiveConversationId();
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
  }, []); // Run once on mount - functions are stable via useCallback

  // Create stable chat config that components can use to create their own Chat instances
  // Each component creates its own independent Chat instance
  // Config is stable - only changes when conversation changes, not during streaming
  // This prevents re-initialization which would abort ongoing streams
  const chatConfig = useMemo(() => {
    if (!currentConversationId) return null;

    return {
      id: currentConversationId,
      messages: initialMessages, // Stable - only updates on conversation load
      transport: new DefaultChatTransport({
        api: `/api/ai_conversations/${currentConversationId}/messages`,
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
    selectedAgent,
    isAgentMode,
    availableAgents,
    loadSelectedAgent,
    setSelectedAgent,
    loadAvailableAgents,
    setCurrentConversationId,
    loadConversation,
    createNewConversation,
    refreshConversation,
  }), [
    chatConfig,
    messages,
    isStreaming,
    stopStreaming,
    currentConversationId,
    initialMessages,
    isInitialized,
    selectedAgent,
    isAgentMode,
    availableAgents,
    loadSelectedAgent,
    setSelectedAgent,
    loadAvailableAgents,
    loadConversation,
    createNewConversation,
    refreshConversation,
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
