'use client';

import React, { createContext, useContext, ReactNode, useState, useReducer, useCallback, useEffect, useMemo, useRef } from 'react';
import { DefaultChatTransport, UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { conversationState } from '@/lib/ai/core/conversation-state';
import { getAgentId, getConversationId, setConversationId } from '@/lib/url-state';
import {
  useChatTransport,
  buildChatConfig,
  GLOBAL_CHAT_ID,
  conversationIdentityReducer,
  conversationIdFrom,
  isResolving,
  type ConversationIdentityState,
} from '@/lib/ai/shared';
import { shouldRefreshOnReconnect } from '@/lib/ai/streams/shouldRefreshOnReconnect';
import { shouldRefreshAfterUndo } from '@/lib/ai/streams/shouldRefreshAfterUndo';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';
import { useSocketStore } from '@/stores/useSocketStore';
import { useAuth } from '@/hooks/useAuth';
import { useChannelStreamSocket } from '@/hooks/useChannelStreamSocket';
import type { ChatGlobalConversationAddedPayload } from '@/lib/websocket/socket-utils';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { getActiveStreamById } from '@/hooks/useActiveStream';
import { DerivedStreamingRegistrations } from '@/components/ai/shared/DerivedStreamingRegistrations';

/**
 * Global Chat Context — two tiers to minimize re-render noise:
 *
 * 1. GlobalChatConversationContext — conversation controls + refreshSignal, rarely changes
 * 2. GlobalChatConfigContext — chatConfig (stable)
 *
 * Messages are owned exclusively by useChat in each surface (GlobalAssistantView,
 * SidebarChatTab). Context holds no duplicate message state.
 *
 * NO STREAM TIER (PR 5A). `isStreaming`/`stopStreaming` used to live here as a single shared
 * SLOT, written by a claim protocol on this side and directly by GlobalAssistantView on the
 * other, and read by SidebarChatTab. Two co-mounted surfaces writing one slot is what the
 * claim/release/re-examine machinery existed to arbitrate — and every "the slot belongs to
 * somebody else" bug came out of it, including the gap where a surface that declined a claim
 * never re-claimed the slot once it was freed, leaving a live stream with no Stop button.
 *
 * That fact now lives in `usePendingStreamsStore`, which already receives
 * {messageId, conversationId, isOwn} on bootstrap AND live stream_start. Both surfaces READ it
 * via `useConversationActiveStream(channelId, conversationId)`. Selectors don't claim, so the
 * whole class is gone by construction rather than by arbitration.
 *
 * Remote events (reconnect, undo, cross-tab messages/edits/deletes) increment
 * `refreshSignal`. Surfaces watch it and self-fetch when it changes. (PR 5B deletes this too.)
 */

// ============================================
// Context Types
// ============================================

interface GlobalChatConversationContextValue {
  currentConversationId: string | null;
  /** Fetched messages from the last loadConversation/createNewConversation.
   *  Surfaces watch this reference and apply via setMessages (not via useChat
   *  config, which ignores the messages prop after construction). */
  initialMessages: UIMessage[];
  isInitialized: boolean;
  /**
   * True while messages are being fetched for an ALREADY-known conversation
   * (loadConversation), decoupled from identity resolution — loadConversation
   * adopts its id synchronously (closing the create/select race), so
   * isInitialized alone no longer covers this fetch window. Without this, a
   * conversation switch could flash the previous conversation's messages
   * under the new conversation's identity/header with no loading indicator.
   */
  isMessagesLoading: boolean;
  /** Increments when remote events require surfaces to re-fetch messages from DB. */
  refreshSignal: number;
  setCurrentConversationId: (id: string | null) => void;
  loadConversation: (id: string) => Promise<void>;
  createNewConversation: () => Promise<void>;
  /** Re-runs the global channel bootstrap to rejoin any still-live own stream. */
  rejoinGlobalStream: () => void;
  /** Most-recently received global conversation-added event (own-tab included). History surfaces watch this to prepend without a refresh. */
  latestGlobalConversationAdded: ChatGlobalConversationAddedPayload | null;
}

interface GlobalChatConfigContextValue {
  chatConfig: {
    id: string;
    transport: DefaultChatTransport<UIMessage>;
    onError: (error: Error) => void;
  } | null;
}

// ============================================
// Contexts
// ============================================

const GlobalChatConversationContext = createContext<GlobalChatConversationContextValue | undefined>(undefined);
const GlobalChatConfigContext = createContext<GlobalChatConfigContextValue | undefined>(undefined);

// ============================================
// Provider
// ============================================

export function GlobalChatProvider({ children }: { children: ReactNode }) {
  // Single source of truth for conversation identity — every transition goes
  // through the shared pure reducer, so a stale in-flight load can never
  // clobber a newer loadConversation/createNewConversation call (the reducer
  // ignores RESOLVED/RESOLVE_FAILED once identity has moved past 'resolving',
  // and IDENTITY_SET always wins regardless of current state).
  //
  // identityRef is updated synchronously by dispatchIdentity itself (not via
  // a render-time effect) so async callbacks checking "is this result still
  // current" right after a dispatch always see the latest value, even before
  // React has committed the corresponding re-render.
  const [identity, setIdentityState] = useReducer(conversationIdentityReducer, { status: 'idle' as const });
  const identityRef = useRef<ConversationIdentityState>(identity);
  const dispatchIdentity = useCallback((action: Parameters<typeof conversationIdentityReducer>[1]) => {
    identityRef.current = conversationIdentityReducer(identityRef.current, action);
    setIdentityState(action);
  }, []);
  const currentConversationId = conversationIdFrom(identity);

  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const isInitialized = !isResolving(identity) && identity.status !== 'idle';
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [latestGlobalConversationAdded, setLatestGlobalConversationAdded] = useState<ChatGlobalConversationAddedPayload | null>(null);


  // The id is already known — adopt it synchronously, before the messages
  // fetch even starts, so a send fired right after switching can't race.
  const loadConversation = useCallback(async (conversationId: string) => {
    dispatchIdentity({ type: 'IDENTITY_SET', conversationId });
    conversationState.setActiveConversationId(conversationId);
    setIsMessagesLoading(true);
    try {
      // includeStreaming=1: leaf 5.2 (history-tab rejoin). A conversation opened from a
      // streaming-badged history entry has an in-flight 'streaming' placeholder row that a
      // default fetch excludes (see chat-message-repository.ts's includeStreaming contract).
      // Including it here is what lets mergeServerAndPending recognize and replace it with
      // the live pending-stream content once the channel-wide bootstrap/socket attach (already
      // running for every conversation via useChannelStreamSocket below) discovers the same
      // stream — no separate rejoin path needed. Harmless for the common non-streaming case:
      // there is no such row to include.
      const messagesResponse = await fetchWithAuth(
        `/api/ai/global/${conversationId}/messages?limit=50&includeStreaming=1`
      );
      // Drop a stale result if the user switched to a different conversation
      // while this fetch was in flight.
      if (conversationIdFrom(identityRef.current) !== conversationId) return;
      if (messagesResponse.ok) {
        const messageData = await messagesResponse.json();
        const loadedMessages = Array.isArray(messageData) ? messageData : messageData.messages || [];
        setInitialMessages(loadedMessages);
      } else {
        console.error('Failed to load conversation:', conversationId);
        setInitialMessages([]);
      }
      setIsMessagesLoading(false);
    } catch (error) {
      console.error('Error loading conversation:', error);
      if (conversationIdFrom(identityRef.current) !== conversationId) return;
      setInitialMessages([]);
      setIsMessagesLoading(false);
    }
  }, [dispatchIdentity]);

  const createNewConversation = useCallback(async () => {
    try {
      const newConversation = await conversationState.createAndSetActiveConversation({
        type: 'global',
      });
      if (newConversation && newConversation.id) {
        dispatchIdentity({ type: 'IDENTITY_SET', conversationId: newConversation.id });
        setInitialMessages([]);
        conversationState.setActiveConversationId(newConversation.id);
        if (!getAgentId()) {
          setConversationId(newConversation.id, 'push');
        }
      }
    } catch (error) {
      console.error('Failed to create new conversation:', error);
    }
  }, [dispatchIdentity]);

  useEffect(() => {
    const initializeGlobalChat = async () => {
      dispatchIdentity({ type: 'RESOLVE_STARTED' });
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
        // Only takes effect if nothing above ever reached IDENTITY_SET —
        // otherwise this is a no-op per the reducer's own guards.
        dispatchIdentity({
          type: 'RESOLVE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to initialize global chat',
        });
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
  const channelId = userId ? globalChannelId(userId) : null;

  const setRefreshSignalRef = useRef(setRefreshSignal);
  setRefreshSignalRef.current = setRefreshSignal;

  const { rejoinActiveStreams: rejoinGlobalStream } = useChannelStreamSocket(channelId ?? undefined, {
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
    onStreamComplete: (messageId, completedConvId, info) => {
      const stream = getActiveStreamById(messageId);
      // Remote or bootstrapped stream: signal surfaces to fetch the persisted message.
      if (stream && stream.conversationId === currentConversationIdRef.current) {
        setRefreshSignalRef.current((n) => n + 1);
        return;
      }
      // The SSE join failed (the stream ran on another web instance), so its store entry
      // was dropped and there is nothing here to render — but the message IS durably
      // persisted. Without this we'd fall through to "our useChat already has it" and
      // silently lose the reply.
      if (info?.joinFailed && completedConvId === currentConversationIdRef.current) {
        setRefreshSignalRef.current((n) => n + 1);
        return;
      }
      // Own fresh stream: surface's useChat already has the message.
    },
    // NO onOwnStreamBootstrap/onActiveStreamsSnapshot/onOwnStreamFinalize claim handlers
    // (PR 5A). `useChannelStreamSocket` already records {messageId, conversationId, isOwn} in
    // usePendingStreamsStore on bootstrap AND live stream_start, before the isOwn/consuming
    // attach decision — so the fact these three handlers used to project into a slot is already
    // in the store, for free, and both surfaces read it with
    // `useConversationActiveStream(channelId, conversationId)`.
    //
    // Deleted with them: the ownership arbitration they needed (which claim wins, whether the
    // slot is still ours to release, re-examining a claim made before identity resolved) and
    // the reconciliation for the paths where a finalize event can never arrive (a socket-instance
    // swap tears the effect down without finalizing, stranding the claim forever). A selector
    // has no claim to strand.
    onGlobalConversationAdded: (payload) => {
      setLatestGlobalConversationAdded(payload);
    },
  });

  const prevConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentConversationId !== prevConversationIdRef.current && currentConversationId) {
      prevConversationIdRef.current = currentConversationId;
    }
  }, [currentConversationId]);

  const apiEndpoint = currentConversationId ? `/api/ai/global/${currentConversationId}/messages` : '';
  const transport = useChatTransport(currentConversationId, apiEndpoint, channelId);

  // NO activeStreams-map cleanup (PR 5A, leaf 5.8): the client-side chatId→streamId map is gone.
  // It existed so Stop could name a stream, but it was only populated once the response HEADERS
  // landed and was torn down by these very cleanups on a conversation switch — so it was empty
  // in both windows where Stop matters most. Aborts now name the stream by messageId (from the
  // store) or by the send-time conversationId, neither of which needs a map to keep in sync,
  // and so neither needs an owner to free it.

  const chatConfig = useMemo(() => {
    if (!currentConversationId || !transport) return null;
    return buildChatConfig({
      id: GLOBAL_CHAT_ID,
      transport,
      onError: (error: Error) => {
        console.error('Global Chat Error:', error);
        if (error.message?.includes('Unauthorized') || error.message?.includes('401')) {
          console.error('Authentication failed - user may need to log in again');
        }
      },
    });
  }, [currentConversationId, transport]);

  // Kept for API compatibility (no current callers) — routes through the
  // same synchronous IDENTITY_SET path as loadConversation/createNewConversation.
  const setCurrentConversationId = useCallback((id: string | null) => {
    if (id) dispatchIdentity({ type: 'IDENTITY_SET', conversationId: id });
  }, [dispatchIdentity]);

  // ============================================
  // Context Values
  // ============================================

  const conversationContextValue: GlobalChatConversationContextValue = useMemo(() => ({
    currentConversationId,
    initialMessages,
    isInitialized,
    isMessagesLoading,
    refreshSignal,
    setCurrentConversationId,
    loadConversation,
    createNewConversation,
    rejoinGlobalStream,
    latestGlobalConversationAdded,
  }), [
    setCurrentConversationId,
    currentConversationId,
    initialMessages,
    isInitialized,
    isMessagesLoading,
    refreshSignal,
    loadConversation,
    createNewConversation,
    rejoinGlobalStream,
    latestGlobalConversationAdded,
  ]);

  const configContextValue: GlobalChatConfigContextValue = useMemo(() => ({
    chatConfig,
  }), [chatConfig]);

  return (
    <GlobalChatConversationContext.Provider value={conversationContextValue}>
      <GlobalChatConfigContext.Provider value={configContextValue}>
        {/* THE app-wide editing-store streaming registration (PR 5A, leaf 5.7) — replaces five
            independent mount sites, this provider's included. Mounted here because this provider
            wraps the entire Layout, so it outlives every chat surface and covers conversations no
            surface is currently showing (a bootstrapped stream keeps its own SWR protection while
            the user is on another page). */}
        <DerivedStreamingRegistrations />
        {children}
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
 * Chat configuration.
 * Stable — only changes on conversation switch.
 */
export function useGlobalChatConfig() {
  const context = useContext(GlobalChatConfigContext);
  if (!context) {
    throw new Error('useGlobalChatConfig must be used within a GlobalChatProvider');
  }
  return context;
}
