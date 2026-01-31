'use client';

import React, { createContext, useContext, ReactNode, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { DefaultChatTransport, UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { conversationState } from '@/lib/ai/core/conversation-state';
import { getAgentId, getConversationId, setConversationId } from '@/lib/url-state';
import { createStreamTrackingFetch, abortActiveStream } from '@/lib/ai/core';

/**
 * Global Chat Context - ONLY for Global Assistant state
 *
 * This context manages the Global Assistant chat that appears in the sidebar.
 * It does NOT manage agent selection or agent conversations.
 *
 * Agent selection is managed by usePageAgentDashboardStore (Zustand store).
 * Agent conversations are managed locally by GlobalAssistantView when in agent mode.
 */
interface GlobalChatContextValue {
  // Chat configuration for Global Assistant
  chatConfig: {
    id: string | undefined;
    messages: UIMessage[];
    transport: DefaultChatTransport<UIMessage>;
    onError: (error: Error) => void;
  } | null;

  // Global message state - shared between sidebar and middle view when in global mode
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;

  // Global streaming status
  isStreaming: boolean;
  setIsStreaming: (streaming: boolean) => void;

  // Global stop function
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
}

const GlobalChatContext = createContext<GlobalChatContextValue | undefined>(undefined);

export function GlobalChatProvider({ children }: { children: ReactNode }) {
  // Conversation management state
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [isInitialized, setIsInitialized] = useState<boolean>(false);

  // Global message state - THE single source of truth for messages
  const [messages, setMessages] = useState<UIMessage[]>([]);

  // Global streaming status
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

  // Global stop function
  const [stopStreaming, setStopStreaming] = useState<(() => void) | null>(null);

  /**
   * Load a conversation by ID
   */
  const loadConversation = useCallback(async (conversationId: string) => {
    try {
      setIsInitialized(false);

      const messagesResponse = await fetchWithAuth(
        `/api/ai/global/${conversationId}/messages?limit=50`
      );

      if (messagesResponse.ok) {
        const messageData = await messagesResponse.json();
        const loadedMessages = Array.isArray(messageData) ? messageData : messageData.messages || [];

        setInitialMessages(loadedMessages);
        setMessages(loadedMessages);
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
      setMessages([]);
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
        setMessages([]);
        conversationState.setActiveConversationId(newConversation.id);

        // Update URL to reflect new conversation (only if no agent selected)
        if (!getAgentId()) {
          setConversationId(newConversation.id, 'push');
        }

        setIsInitialized(true);
      }
    } catch (error) {
      console.error('Failed to create new conversation:', error);
    }
  }, []);

  /**
   * Refresh the current conversation
   */
  const refreshConversation = useCallback(async () => {
    if (currentConversationId) {
      await loadConversation(currentConversationId);
    }
  }, [currentConversationId, loadConversation]);

  /**
   * Initialize Global Assistant chat on mount
   * Agent initialization is handled separately by usePageAgentDashboardStore
   */
  useEffect(() => {
    const initializeGlobalChat = async () => {
      try {
        const urlConversationId = getConversationId();
        const urlAgentId = getAgentId();
        const cookieConversationId = conversationState.getActiveConversationId();
        const cookieAgentId = conversationState.getActiveAgentId();

        // Determine if an agent is selected (from URL or cookie)
        const hasAgent = Boolean(urlAgentId || cookieAgentId);

        // If no agent selected, try to load from URL or cookie
        if (!hasAgent && (urlConversationId || cookieConversationId)) {
          const conversationId = urlConversationId || cookieConversationId;
          if (conversationId) {
            await loadConversation(conversationId);
            return;
          }
        }

        // Always try to get the most recent global conversation
        // This ensures sidebar has a conversation to display
        const response = await fetchWithAuth('/api/ai/global/active');
        if (response.ok) {
          const conversation = await response.json();
          if (conversation && conversation.id) {
            await loadConversation(conversation.id);

            // Only update URL if no agent is selected
            if (!hasAgent) {
              setConversationId(conversation.id, 'replace');
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

  // Track the previous conversation ID to detect conversation switches
  const prevConversationIdRef = useRef<string | null>(null);

  // Sync initialMessages with current messages ONLY when conversation ID changes
  // This ensures useChat gets the correct messages when switching conversations from history
  // without causing chatConfig to update on every message
  useEffect(() => {
    const conversationJustSwitched = currentConversationId !== prevConversationIdRef.current;

    if (conversationJustSwitched && currentConversationId) {
      // On conversation switch, initialMessages is already set by loadConversation
      // Just update our tracking ref
      prevConversationIdRef.current = currentConversationId;
    }
  }, [currentConversationId]);

  // Create stable chat config
  // IMPORTANT: Uses initialMessages which is set by loadConversation when switching conversations.
  // The chatConfig only changes when:
  // 1. currentConversationId changes (switching conversations)
  // 2. initialMessages changes (set during loadConversation)
  // This keeps the config stable during normal messaging to avoid confusing useChat.
  const chatConfig = useMemo(() => {
    if (!currentConversationId) return null;

    const apiEndpoint = `/api/ai/global/${currentConversationId}/messages`;

    return {
      id: currentConversationId,
      messages: initialMessages,
      transport: new DefaultChatTransport({
        api: apiEndpoint,
        // Use stream tracking fetch to capture streamId from response headers
        // This enables explicit abort via /api/ai/abort endpoint
        fetch: createStreamTrackingFetch({ chatId: currentConversationId }),
      }),
      experimental_throttle: 100, // Match agent mode throttle for consistent streaming feel
      onError: (error: Error) => {
        console.error('❌ Global Chat Error:', error);
        if (error.message?.includes('Unauthorized') || error.message?.includes('401')) {
          console.error('🔒 Authentication failed - user may need to log in again');
        }
      },
    };
  }, [currentConversationId, initialMessages]);

  // Create abort function for explicit user stop
  const handleAbortStream = useCallback(async () => {
    if (!currentConversationId) return;
    await abortActiveStream({ chatId: currentConversationId });
  }, [currentConversationId]);

  // Context value
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
  ]);

  return (
    <GlobalChatContext.Provider value={contextValue}>
      {children}
    </GlobalChatContext.Provider>
  );
}

/**
 * Hook to access the shared global chat context
 */
export function useGlobalChat() {
  const context = useContext(GlobalChatContext);
  if (!context) {
    throw new Error('useGlobalChat must be used within a GlobalChatProvider');
  }
  return context;
}
