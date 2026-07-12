'use client';

import React, { createContext, useContext, ReactNode, useState, useReducer, useCallback, useEffect, useMemo, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { DefaultChatTransport, UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { conversationState } from '@/lib/ai/core/conversation-state';
import { getAgentId, getConversationId, setConversationId } from '@/lib/url-state';
import {
  useChatTransport,
  useStreamingRegistration,
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
import { abortActiveStreamByMessageId, clearActiveStreamId } from '@/lib/ai/core/stream-abort-client';
import { shouldClaimGlobalStopSlot } from '@/lib/ai/streams/shouldClaimGlobalStopSlot';
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

interface GlobalChatStreamContextValue {
  isStreaming: boolean;
  stopStreaming: (() => void) | null;
}

interface GlobalChatConfigContextValue {
  chatConfig: {
    id: string;
    transport: DefaultChatTransport<UIMessage>;
    onError: (error: Error) => void;
  } | null;
  setIsStreaming: (streaming: boolean) => void;
  /**
   * The raw useState dispatch — so a FUNCTION argument is an UPDATER, not a value.
   *
   * Typed honestly as SetStateAction because the old signature lied: it invited callers to
   * pass a stop fn directly, which React would then CALL as an updater — aborting the
   * stream on the spot and storing `undefined`. To store a stop fn, wrap it:
   * `setStopStreaming(() => stopFn)`.
   */
  setStopStreaming: Dispatch<SetStateAction<(() => void) | null>>;
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
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [stopStreaming, setStopStreaming] = useState<(() => void) | null>(null);
  const [latestGlobalConversationAdded, setLatestGlobalConversationAdded] = useState<ChatGlobalConversationAddedPayload | null>(null);

  // Protects bootstrap-replayed own streams from SWR clobbers while useChat
  // on the surface is still at idle (before it re-engages after a refresh).
  useStreamingRegistration('global-chat', isStreaming, {
    componentName: 'GlobalChatProvider',
  });

  // The id is already known — adopt it synchronously, before the messages
  // fetch even starts, so a send fired right after switching can't race.
  const loadConversation = useCallback(async (conversationId: string) => {
    dispatchIdentity({ type: 'IDENTITY_SET', conversationId });
    conversationState.setActiveConversationId(conversationId);
    setIsMessagesLoading(true);
    try {
      const messagesResponse = await fetchWithAuth(
        `/api/ai/global/${conversationId}/messages?limit=50`
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

  const setIsStreamingRef = useRef(setIsStreaming);
  setIsStreamingRef.current = setIsStreaming;
  const setStopStreamingRef = useRef(setStopStreaming);
  setStopStreamingRef.current = setStopStreaming;
  // The stop fn currently INSTALLED, and the one WE installed. `isStreaming`/`stopStreaming`
  // is a single shared slot that GlobalAssistantView also writes directly from its local
  // chat status, outside the claim protocol — so "I claimed for messageId M" does not mean
  // the slot still holds my stop fn by the time M finalizes. Releasing on the messageId
  // alone would kill a Stop button (and the streaming flag, and its SWR-clobber protection)
  // belonging to a DIFFERENT, live stream. The takeover makes this deterministic: a new
  // send aborts the bootstrapped stream M, whose chat:stream_complete then arrives while
  // the new stream is the one on screen.
  const currentStopStreamingRef = useRef<(() => void) | null>(stopStreaming);
  currentStopStreamingRef.current = stopStreaming;
  const ownedStopFnRef = useRef<(() => void) | null>(null);
  // WHICH conversation the claim belongs to. The claim is deliberately allowed to land
  // before this surface has resolved its identity (rejecting on a null id there would drop
  // the very stream we are about to render) — but a claim made in ignorance must be
  // re-examined once we know. Without this, a stream in conversation X could keep the Stop
  // button lit for conversation Y.
  const claimedConvIdRef = useRef<string | null>(null);

  // A DIFFERENT fn installed means another, live stream owns the slot — leave both halves
  // alone. A NULL slot means nobody owns it: it is free, and still ours to clear.
  // (GlobalAssistantView nulls the stop fn on ordinary paths — its effect's else-branch and
  // cleanup fire whenever the chat status is 'ready', which it is for the whole life of a
  // BOOTSTRAPPED stream — without ever touching isStreaming. Reading that as "not ours"
  // would strand isStreaming true and brick the composer.)
  const releaseStopSlotIfStillOurs = () => {
    if (claimedStopMessageIdRef.current === null) return;
    const current = currentStopStreamingRef.current;
    const stillOurs = current === ownedStopFnRef.current || current === null;
    claimedStopMessageIdRef.current = null;
    claimedConvIdRef.current = null;
    ownedStopFnRef.current = null;
    if (!stillOurs) return;
    setIsStreamingRef.current(false);
    setStopStreamingRef.current(null);
  };
  const releaseStopSlotRef = useRef(releaseStopSlotIfStillOurs);
  releaseStopSlotRef.current = releaseStopSlotIfStillOurs;
  const setRefreshSignalRef = useRef(setRefreshSignal);
  setRefreshSignalRef.current = setRefreshSignal;

  const claimedStopMessageIdRef = useRef<string | null>(null);

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
      const stream = usePendingStreamsStore.getState().streams.get(messageId);
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
    onOwnStreamBootstrap: ({ messageId, conversationId }) => {
      // Conversation-scoped: an own stream in another conversation on this user's
      // global channel must not light up the Stop button for the one on screen.
      // Only reject a KNOWN mismatch — the DB bootstrap can land before the
      // conversation identity has resolved, and rejecting on a null id there would
      // drop the very stream this surface is about to render.
      // Single-writer, and conversation-scoped. See shouldClaimGlobalStopSlot: the bootstrap sweep
      // fires once per own in-flight stream, so two live own streams land here in one loop — and
      // an unconditional claim let the second silently destroy the first.
      const claimable = shouldClaimGlobalStopSlot({
        incomingMessageId: messageId,
        incomingConversationId: conversationId,
        heldMessageId: claimedStopMessageIdRef.current,
        heldConversationId: claimedConvIdRef.current,
        activeConversationId: currentConversationIdRef.current,
      });
      if (!claimable) return;

      const stopFn = () => {
        abortActiveStreamByMessageId({ messageId });
      };
      claimedStopMessageIdRef.current = messageId;
      claimedConvIdRef.current = conversationId;
      ownedStopFnRef.current = stopFn;
      setIsStreamingRef.current(true);
      setStopStreamingRef.current(() => stopFn);
    },
    // Same reconciliation as useAgentChannelMultiplayer: a claim released only by
    // onOwnStreamFinalize strands forever on the paths where that event cannot fire (a
    // socket-instance swap tears the effect down without finalizing). Bootstrap is the
    // server's word on what is still running.
    onActiveStreamsSnapshot: (liveMessageIds) => {
      const claimed = claimedStopMessageIdRef.current;
      if (claimed === null || liveMessageIds.has(claimed)) return;
      releaseStopSlotRef.current();
    },
    onOwnStreamFinalize: ({ messageId }) => {
      // Only the stream that actually claimed the Stop control may release it.
      if (claimedStopMessageIdRef.current !== messageId) return;
      releaseStopSlotRef.current();
    },
    onGlobalConversationAdded: (payload) => {
      setLatestGlobalConversationAdded(payload);
    },
  });

  // A claim made before identity resolved is a claim made in ignorance. Once we know which
  // conversation this surface is actually showing, a claim that names a DIFFERENT one is not
  // ours to hold: it would keep the Stop button lit, and the composer disabled, for a stream
  // the user is not looking at. Re-examine it the moment the answer arrives.
  useEffect(() => {
    const claimedConvId = claimedConvIdRef.current;
    if (claimedConvId === null) return;
    if (currentConversationId === null) return; // still unknown — keep holding
    if (claimedConvId === currentConversationId) return;
    releaseStopSlotRef.current();
  }, [currentConversationId]);

  const prevConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentConversationId !== prevConversationIdRef.current && currentConversationId) {
      prevConversationIdRef.current = currentConversationId;
    }
  }, [currentConversationId]);

  const apiEndpoint = currentConversationId ? `/api/ai/global/${currentConversationId}/messages` : '';
  const transport = useChatTransport(currentConversationId, apiEndpoint, channelId);

  // This context REGISTERS `currentConversationId` in the activeStreams map (the transport above),
  // and until now nothing ever freed it — GlobalAssistantView's unmount cleanup was clearing this
  // key, but that surface does not own it, and it is gone the moment you navigate off the
  // dashboard while the context lives on. So: the owner frees its own key, and only its own.
  useEffect(() => {
    if (!currentConversationId) return;
    return () => {
      clearActiveStreamId({ chatId: currentConversationId });
    };
  }, [currentConversationId]);

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
