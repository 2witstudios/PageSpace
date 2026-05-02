'use client';

import React, { createContext, useContext, ReactNode, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { DefaultChatTransport, UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { conversationState } from '@/lib/ai/core/conversation-state';
import { getAgentId, getConversationId, setConversationId } from '@/lib/url-state';
import { useChatTransport, useStreamingRegistration } from '@/lib/ai/shared';
import { shouldRefreshOnReconnect } from '@/lib/ai/streams/shouldRefreshOnReconnect';
import { applyMessageEdit } from '@/lib/ai/streams/applyMessageEdit';
import { applyMessageDelete } from '@/lib/ai/streams/applyMessageDelete';
import { shouldRefreshAfterUndo } from '@/lib/ai/streams/shouldRefreshAfterUndo';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';
import { useSocketStore } from '@/stores/useSocketStore';
import { useAuth } from '@/hooks/useAuth';
import { useChannelStreamSocket } from '@/hooks/useChannelStreamSocket';
import { abortActiveStreamByMessageId } from '@/lib/ai/core/stream-abort-client';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';

/**
 * Global Chat Context - Split into three tiers to minimize re-render noise:
 *
 * 1. GlobalChatConversationContext — conversation controls, rarely changes
 * 2. GlobalChatStreamContext — messages, isStreaming, stopStreaming (changes during streaming)
 * 3. GlobalChatConfigContext — chatConfig, setMessages, setIsStreaming, setStopStreaming (stable)
 *
 * Components subscribe only to what they need:
 * - SidebarChatTab: config + stream (streaming indicators + chatConfig)
 * - GlobalAssistantView: config + stream (chatConfig + setters + streaming)
 * - History panel: conversation only
 * - Other UI: conversation only
 */

// ============================================
// Context Types
// ============================================

interface GlobalChatConversationContextValue {
  currentConversationId: string | null;
  initialMessages: UIMessage[];
  isInitialized: boolean;
  setCurrentConversationId: (id: string | null) => void;
  loadConversation: (id: string) => Promise<void>;
  createNewConversation: () => Promise<void>;
  refreshConversation: () => Promise<void>;
}

interface GlobalChatStreamContextValue {
  messages: UIMessage[];
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
  setMessages: (messages: UIMessage[]) => void;
  setIsStreaming: (streaming: boolean) => void;
  setStopStreaming: (fn: (() => void) | null) => void;
}

// Legacy combined interface for backward compatibility
interface GlobalChatContextValue extends GlobalChatConversationContextValue, GlobalChatStreamContextValue, GlobalChatConfigContextValue {}

// ============================================
// Contexts
// ============================================

const GlobalChatConversationContext = createContext<GlobalChatConversationContextValue | undefined>(undefined);
const GlobalChatStreamContext = createContext<GlobalChatStreamContextValue | undefined>(undefined);
const GlobalChatConfigContext = createContext<GlobalChatConfigContextValue | undefined>(undefined);
// Legacy combined context — kept for backward compatibility
const GlobalChatContext = createContext<GlobalChatContextValue | undefined>(undefined);

// ============================================
// Provider
// ============================================

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

  // Protects bootstrap-replayed own streams from SWR clobbers. Surfaces
  // (GlobalAssistantView, SidebarChatTab) register based on local useChat
  // status, which is `idle` immediately after a refresh — so they miss the
  // case where the hook re-detects an in-flight own stream and flips this
  // provider's isStreaming. This registration covers that gap.
  useStreamingRegistration('global-chat', isStreaming, {
    componentName: 'GlobalChatProvider',
  });

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

  const connectionStatus = useSocketStore((s) => s.connectionStatus);
  const hasInitialConnectRef = useRef(false);
  // Track previous status to detect transitions INTO 'connected' rather than reacting
  // to the static value. Without this, dep changes (e.g. currentConversationId on
  // conversation switch) would re-fire the effect while already connected and trigger
  // a spurious double-fetch.
  const prevConnectionStatusRef = useRef<typeof connectionStatus | null>(null);
  // Ref keeps isInitialized readable inside the effect without making it a dep.
  // If isInitialized were a dep, loadConversation's false→true cycle could re-trigger
  // the effect after a refresh completes, causing an infinite refresh loop in production.
  const isInitializedRef = useRef(false);
  isInitializedRef.current = isInitialized;

  useEffect(() => {
    const prevStatus = prevConnectionStatusRef.current;
    prevConnectionStatusRef.current = connectionStatus;

    const refreshNow = shouldRefreshOnReconnect(
      prevStatus,
      connectionStatus,
      hasInitialConnectRef.current,
    );
    if (refreshNow && isInitializedRef.current && currentConversationId) {
      refreshConversation();
    }

    const isFreshConnect = prevStatus !== 'connected' && connectionStatus === 'connected';
    if (isFreshConnect) {
      hasInitialConnectRef.current = true;
    }
  }, [connectionStatus, currentConversationId, refreshConversation]);

  // ============================================
  // GLOBAL CHANNEL STREAM SOCKET — bootstrap + live events
  // ============================================
  // Hook handles DB replay, live chat:stream_start/_complete, SSE join, and
  // teardown. Local own-stream side effects (the in-flight streaming flag and
  // stop-button slot driven by useChat in this tab) are wired through the
  // own-stream callbacks below.
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const channelId = userId ? globalChannelId(userId) : undefined;

  // Always-current refs so the hook's stable callbacks can call into the
  // latest setters/refresh without forcing the hook to resubscribe.
  const setIsStreamingRef = useRef(setIsStreaming);
  setIsStreamingRef.current = setIsStreaming;
  const setStopStreamingRef = useRef(setStopStreaming);
  setStopStreamingRef.current = setStopStreaming;
  const refreshConversationRef = useRef(refreshConversation);
  refreshConversationRef.current = refreshConversation;

  useChannelStreamSocket(channelId, {
    onUserMessage: (message, payload) => {
      if (payload.conversationId !== currentConversationId) return;
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    },
    onMessageEdited: (payload) => {
      if (payload.conversationId !== currentConversationId) return;
      setMessages((prev) =>
        applyMessageEdit(prev, {
          messageId: payload.messageId,
          parts: payload.parts,
          editedAt: new Date(payload.editedAt),
        }),
      );
    },
    onMessageDeleted: (payload) => {
      if (payload.conversationId !== currentConversationId) return;
      setMessages((prev) => applyMessageDelete(prev, payload.messageId));
    },
    onUndoApplied: (payload) => {
      if (!shouldRefreshAfterUndo(payload, currentConversationId, getBrowserSessionId())) return;
      refreshConversationRef.current();
    },
    onStreamComplete: () => {
      refreshConversationRef.current();
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

  // Stable transport that only recreates when conversation ID changes
  const apiEndpoint = currentConversationId ? `/api/ai/global/${currentConversationId}/messages` : '';
  const transport = useChatTransport(currentConversationId, apiEndpoint);

  // Create stable chat config
  // IMPORTANT: Uses initialMessages which is set by loadConversation when switching conversations.
  // The chatConfig only changes when:
  // 1. currentConversationId changes (switching conversations)
  // 2. initialMessages changes (set during loadConversation)
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
  // Context Values — separate memo for each tier
  // ============================================

  // Tier 1: Conversation controls — rarely changes
  const conversationContextValue: GlobalChatConversationContextValue = useMemo(() => ({
    currentConversationId,
    initialMessages,
    isInitialized,
    setCurrentConversationId,
    loadConversation,
    createNewConversation,
    refreshConversation,
  }), [
    currentConversationId,
    initialMessages,
    isInitialized,
    loadConversation,
    createNewConversation,
    refreshConversation,
  ]);

  // Tier 2: Stream state — changes during streaming (messages on every token, isStreaming on start/stop)
  const streamContextValue: GlobalChatStreamContextValue = useMemo(() => ({
    messages,
    isStreaming,
    stopStreaming,
  }), [messages, isStreaming, stopStreaming]);

  // Tier 3: Config — stable, only changes on conversation switch
  const configContextValue: GlobalChatConfigContextValue = useMemo(() => ({
    chatConfig,
    setMessages,
    setIsStreaming,
    setStopStreaming,
  }), [chatConfig]);

  // Legacy combined value — for backward compatibility with useGlobalChat()
  const legacyContextValue: GlobalChatContextValue = useMemo(() => ({
    ...conversationContextValue,
    ...streamContextValue,
    ...configContextValue,
  }), [conversationContextValue, streamContextValue, configContextValue]);

  return (
    <GlobalChatConversationContext.Provider value={conversationContextValue}>
      <GlobalChatConfigContext.Provider value={configContextValue}>
        <GlobalChatStreamContext.Provider value={streamContextValue}>
          <GlobalChatContext.Provider value={legacyContextValue}>
            {children}
          </GlobalChatContext.Provider>
        </GlobalChatStreamContext.Provider>
      </GlobalChatConfigContext.Provider>
    </GlobalChatConversationContext.Provider>
  );
}

// ============================================
// Hooks
// ============================================

/**
 * Hook to access the full global chat context (backward compatible).
 * Subscribes to ALL tiers — use selective hooks below to reduce re-renders.
 */
export function useGlobalChat() {
  const context = useContext(GlobalChatContext);
  if (!context) {
    throw new Error('useGlobalChat must be used within a GlobalChatProvider');
  }
  return context;
}

/**
 * Hook to access global conversation controls without subscribing to streaming state.
 * Best for: history panels, navigation, conversation management.
 */
export function useGlobalChatConversation() {
  const context = useContext(GlobalChatConversationContext);
  if (!context) {
    throw new Error('useGlobalChatConversation must be used within a GlobalChatProvider');
  }
  return context;
}

/**
 * Hook to access streaming state (messages, isStreaming, stopStreaming).
 * Re-renders on every streaming token — only use if you display messages from context.
 */
export function useGlobalChatStream() {
  const context = useContext(GlobalChatStreamContext);
  if (!context) {
    throw new Error('useGlobalChatStream must be used within a GlobalChatProvider');
  }
  return context;
}

/**
 * Hook to access chat configuration and setters.
 * Stable — only changes on conversation switch.
 * Best for: useChat consumers that need chatConfig + setters.
 */
export function useGlobalChatConfig() {
  const context = useContext(GlobalChatConfigContext);
  if (!context) {
    throw new Error('useGlobalChatConfig must be used within a GlobalChatProvider');
  }
  return context;
}
