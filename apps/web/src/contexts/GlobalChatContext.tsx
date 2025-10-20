'use client';

import React, { createContext, useContext, ReactNode, useState, useCallback, useEffect, useMemo } from 'react';
import { DefaultChatTransport, UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { conversationState } from '@/lib/ai/conversation-state';

interface GlobalChatContextValue {
  // Shared chat configuration for creating Chat instances
  // Each component creates its own Chat instance with this config
  chatConfig: {
    id: string | undefined;
    messages: UIMessage[];
    transport: DefaultChatTransport<UIMessage>;
    onError: (error: Error) => void;
  } | null;

  // Current conversation state
  currentConversationId: string | null;
  initialMessages: UIMessage[];
  isInitialized: boolean;

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
        const messages = Array.isArray(messageData) ? messageData : messageData.messages || [];

        setInitialMessages(messages);
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
   * Initialize with most recent global conversation on mount
   */
  useEffect(() => {
    const initializeGlobalChat = async () => {
      try {
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

  // Create chat config that components can use to create their own Chat instances
  // This ensures each component's useChat hook properly subscribes to its own instance
  const chatConfig = useMemo(() => {
    if (!currentConversationId) return null;

    return {
      id: currentConversationId,
      messages: initialMessages,
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

  // Context value without memoization - allows chat config updates to propagate immediately
  // Functions are already stable via useCallback
  const contextValue: GlobalChatContextValue = {
    chatConfig,
    currentConversationId,
    initialMessages,
    isInitialized,
    setCurrentConversationId,
    loadConversation,
    createNewConversation,
    refreshConversation,
  };

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
