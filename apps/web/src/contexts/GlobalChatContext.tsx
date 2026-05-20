'use client';

import React, { createContext, useContext, ReactNode, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { DefaultChatTransport, UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { conversationState } from '@/lib/ai/core/conversation-state';
import { getAgentId, getConversationId, setConversationId } from '@/lib/url-state';
import { useChatTransport, useStreamingRegistration } from '@/lib/ai/shared';
import { shouldRefreshOnReconnect } from '@/lib/ai/streams/shouldRefreshOnReconnect';
import { shouldRefreshAfterUndo } from '@/lib/ai/streams/shouldRefreshAfterUndo';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';
import { useSocketStore } from '@/stores/useSocketStore';
import { useAuth } from '@/hooks/useAuth';
import { useChannelStreamSocket } from '@/hooks/useChannelStreamSocket';
import { abortActiveStreamByMessageId } from '@/lib/ai/core/stream-abort-client';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';

/**
 * Global Chat Context — three tiers to minimize re-render noise:
 *
 * 1. GlobalChatConversationContext — conversation controls + refreshSignal, rarely changes
 * 2. GlobalChatStreamContext — isStreaming, stopStreaming (changes during streaming)
 * 3. GlobalChatConfigContext — chatConfig, setIsStreaming, setStopStreaming (stable)
 *
 * Messages are owned exclusively by useChat in each surface (GlobalAssistantView,
 * SidebarChatTab). Context holds no duplicate message state.
 *
 * Remote events (reconnect, undo, cross-tab messages/edits/deletes) increment
 * `refreshSignal`. Surfaces watch it and self-fetch when it changes.
 */

// ============================================
// Context Types
// ============================================

interface GlobalChatConversationContextValue {
  currentConversationId: string | null;
  /** Seed messages for useChat — set by loadConversation on conversation switch. */
  initialMessages: UIMessage[];
  isInitialized: boolean;
  /** Increments when remote events require surfaces to re-fetch messages from DB. */
  refreshSignal: number;
  setCurrentConversationId: (id: string | null) => void;
  loadConversation: (id: string) => Promise<void>;
  createNewConversation: () => Promise<void>;
}

interface GlobalChatStreamContextValue {
  isStreaming: boolean;
  stopStreaming: (() => void) | null;
}

interface GlobalChatConfigContextValue {
  chatConfig: {
    id: string | undefined;
    messages: UIMessage[];
    transport: DefaultChatTransport<UIMessage>;
    onError: (error: Error) => void;
  } | null;
  setIsStreaming: (streaming: boolean) => void;
  setStopStreaming: (fn: (() => void) | null) => void;
}

// ============================================
// Contexts
// ============================================

const GlobalChatConversationContext = createContext<GlobalChatConversationContextValue | undefined>(undefined);
const GlobalChatStreamContext = createContext<GlobalChatStreamContextValue | undefined>(undefined);
const GlobalChatConfigContext = createContext<GlobalChatConfigContextValue | undefined>(undefined);

// ============================================
// Provider
// ============================================

export function GlobalChatProvider({ children }: { children: ReactNode }) {
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [isInitialized, setIsInitialized] = useState<boolean>(false);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [stopStreaming, setStopStreaming] = useState<(() => void) | null>(null);

  // Protects bootstrap-replayed own streams from SWR clobbers while useChat
  // on the surface is still at idle (before it re-engages after a refresh).
  useStreamingRegistration('global-chat', isStreaming, {
    componentName: 'GlobalChatProvider',
  });

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

  const createNewConversation = useCallback(async () => {
    try {
      const newConversation = await conversationState.createAndSetActiveConversation({
        type: 'global',
      });
      if (newConversation && newConversation.id) {
        setCurrentConversationId(newConversation.id);
        setInitialMessages([]);
        conversationState.setActiveConversationId(newConversation.id);
        if (!getAgentId()) {
          setConversationId(newConversation.id, 'push');
        }
        setIsInitialized(true);
      }
    } catch (error) {
      console.error('Failed to create new conversation:', error);
    }
  }, []);

  useEffect(() => {
    const initializeGlobalChat = async () => {
      try {
        const urlConversationId = getConversationId();
        const urlAgentId = getAgentId();
        const cookieConversationId = conversationState.getActiveConversationId();
        const cookieAgentId = conversationState.getActiveAgentId();
        const hasAgent = Boolean(urlAgentId || cookieAgentId);

        if (!hasAgent && (urlConversationId || cookieConversationId)) {
          const conversationId = urlConversationId || cookieConversationId;
          if (conversationId) {
            await loadConversation(conversationId);
            return;
          }
        }

        const response = await fetchWithAuth('/api/ai/global/active');
        if (response.ok) {
          const conversation = await response.json();
          if (conversation && conversation.id) {
            await loadConversation(conversation.id);
            if (!hasAgent) {
              setConversationId(conversation.id, 'replace');
            }
            return;
          }
        }

        await createNewConversation();
      } catch (error) {
        console.error('Failed to initialize global chat:', error);
        setIsInitialized(true);
      }
    };

    initializeGlobalChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============================================
  // Socket reconnect — signal surfaces rather than fetching here.
  // Fetching here can't reach surface useChat setters and triggers an
  // unnecessary loading-spinner flash via setIsInitialized(false).
  // ============================================
  const connectionStatus = useSocketStore((s) => s.connectionStatus);
  const hasInitialConnectRef = useRef(false);
  const prevConnectionStatusRef = useRef<typeof connectionStatus | null>(null);
  const isInitializedRef = useRef(false);
  isInitializedRef.current = isInitialized;
  const currentConversationIdRef = useRef(currentConversationId);
  currentConversationIdRef.current = currentConversationId;

  useEffect(() => {
    const prevStatus = prevConnectionStatusRef.current;
    prevConnectionStatusRef.current = connectionStatus;

    const refreshNow = shouldRefreshOnReconnect(
      prevStatus,
      connectionStatus,
      hasInitialConnectRef.current,
    );
    if (refreshNow && isInitializedRef.current && currentConversationIdRef.current) {
      setRefreshSignal((n) => n + 1);
    }

    if (prevStatus !== 'connected' && connectionStatus === 'connected') {
      hasInitialConnectRef.current = true;
    }
  }, [connectionStatus]);

  // ============================================
  // GLOBAL CHANNEL STREAM SOCKET
  // ============================================
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const channelId = userId ? globalChannelId(userId) : undefined;

  const setIsStreamingRef = useRef(setIsStreaming);
  setIsStreamingRef.current = setIsStreaming;
  const setStopStreamingRef = useRef(setStopStreaming);
  setStopStreamingRef.current = setStopStreaming;
  const setRefreshSignalRef = useRef(setRefreshSignal);
  setRefreshSignalRef.current = setRefreshSignal;

  useChannelStreamSocket(channelId, {
    // Cross-tab same-user events: signal surfaces to re-fetch rather than
    // updating context state that nobody renders from.
    onUserMessage: (_message, payload) => {
      if (payload.conversationId !== currentConversationId) return;
      setRefreshSignalRef.current((n) => n + 1);
    },
    onMessageEdited: (payload) => {
      if (payload.conversationId !== currentConversationId) return;
      setRefreshSignalRef.current((n) => n + 1);
    },
    onMessageDeleted: (payload) => {
      if (payload.conversationId !== currentConversationId) return;
      setRefreshSignalRef.current((n) => n + 1);
    },
    onUndoApplied: (payload) => {
      if (!shouldRefreshAfterUndo(payload, currentConversationId, getBrowserSessionId())) return;
      setRefreshSignalRef.current((n) => n + 1);
    },
    onStreamComplete: (messageId) => {
      const stream = usePendingStreamsStore.getState().streams.get(messageId);
      // Remote or bootstrapped stream: signal surfaces to fetch the persisted message.
      if (stream && stream.conversationId === currentConversationId) {
        setRefreshSignalRef.current((n) => n + 1);
        return;
      }
      // Own fresh stream: surface's useChat already has the message.
    },
    onOwnStreamBootstrap: ({ messageId }) => {
      setIsStreamingRef.current(true);
      setStopStreamingRef.current(() => () => {
        abortActiveStreamByMessageId({ messageId });
      });
    },
    onOwnStreamFinalize: () => {
      setIsStreamingRef.current(false);
      setStopStreamingRef.current(null);
    },
  });

  const prevConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentConversationId !== prevConversationIdRef.current && currentConversationId) {
      prevConversationIdRef.current = currentConversationId;
    }
  }, [currentConversationId]);

  const apiEndpoint = currentConversationId ? `/api/ai/global/${currentConversationId}/messages` : '';
  const transport = useChatTransport(currentConversationId, apiEndpoint);

  const chatConfig = useMemo(() => {
    if (!currentConversationId || !transport) return null;
    return {
      id: currentConversationId,
      messages: initialMessages,
      transport,
      experimental_throttle: 100,
      onError: (error: Error) => {
        console.error('Global Chat Error:', error);
        if (error.message?.includes('Unauthorized') || error.message?.includes('401')) {
          console.error('Authentication failed - user may need to log in again');
        }
      },
    };
  }, [currentConversationId, transport, initialMessages]);

  // ============================================
  // Context Values
  // ============================================

  const conversationContextValue: GlobalChatConversationContextValue = useMemo(() => ({
    currentConversationId,
    initialMessages,
    isInitialized,
    refreshSignal,
    setCurrentConversationId,
    loadConversation,
    createNewConversation,
  }), [
    currentConversationId,
    initialMessages,
    isInitialized,
    refreshSignal,
    loadConversation,
    createNewConversation,
  ]);

  const streamContextValue: GlobalChatStreamContextValue = useMemo(() => ({
    isStreaming,
    stopStreaming,
  }), [isStreaming, stopStreaming]);

  const configContextValue: GlobalChatConfigContextValue = useMemo(() => ({
    chatConfig,
    setIsStreaming,
    setStopStreaming,
  }), [chatConfig]);

  return (
    <GlobalChatConversationContext.Provider value={conversationContextValue}>
      <GlobalChatConfigContext.Provider value={configContextValue}>
        <GlobalChatStreamContext.Provider value={streamContextValue}>
          {children}
        </GlobalChatStreamContext.Provider>
      </GlobalChatConfigContext.Provider>
    </GlobalChatConversationContext.Provider>
  );
}

// ============================================
// Hooks
// ============================================

/**
 * Conversation controls without subscribing to streaming state.
 * Best for: history panels, navigation, conversation management.
 * Also provides `refreshSignal` for surfaces that need to re-fetch on remote events.
 */
export function useGlobalChatConversation() {
  const context = useContext(GlobalChatConversationContext);
  if (!context) {
    throw new Error('useGlobalChatConversation must be used within a GlobalChatProvider');
  }
  return context;
}

/**
 * Streaming state (isStreaming, stopStreaming).
 * Does NOT include messages — surfaces own their message state via useChat.
 */
export function useGlobalChatStream() {
  const context = useContext(GlobalChatStreamContext);
  if (!context) {
    throw new Error('useGlobalChatStream must be used within a GlobalChatProvider');
  }
  return context;
}

/**
 * Chat configuration and streaming setters.
 * Stable — only changes on conversation switch.
 */
export function useGlobalChatConfig() {
  const context = useContext(GlobalChatConfigContext);
  if (!context) {
    throw new Error('useGlobalChatConfig must be used within a GlobalChatProvider');
  }
  return context;
}
