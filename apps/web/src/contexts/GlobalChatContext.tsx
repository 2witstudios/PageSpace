'use client';

import React, { createContext, useContext, ReactNode, useReducer, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { loadGlobalConversationMessages, refreshConversationSnapshot } from '@/hooks/conversationMessagesLoaders';
import { buildConversationCacheHandlers } from '@/hooks/conversationCacheSocketHandlers';
import { DerivedStreamingRegistrations } from '@/components/ai/shared/DerivedStreamingRegistrations';

/**
 * Global Chat Context — two tiers to minimize re-render noise:
 *
 * 1. GlobalChatConversationContext — conversation identity + controls, rarely changes
 * 2. GlobalChatConfigContext — chatConfig (stable)
 *
 * NO MESSAGE TIER (PR 5B). `initialMessages`/`isMessagesLoading` used to live here as a
 * fetched-messages slot the surfaces watched and copied into their useChat instances via
 * setMessages — one refetch-and-replace writer among several, each of which could clobber a
 * live stream and so each of which grew a clobber guard (#2061). Loads now commit to
 * `useConversationMessagesStore` (the shared per-conversation cache) via
 * `loadGlobalConversationMessages`, and surfaces render
 * `selectRenderedMessages(cacheEntry, activeStreams)` through the `useRenderedMessages`
 * facade — merge-at-render, so no effect ordering can blank a live stream, and the guards
 * are deleted rather than arbitrated.
 *
 * NO refreshSignal (PR 5B, leaf 5.4). Remote events (reconnect, undo, cross-tab
 * edits/deletes, stream completions) no longer signal surfaces to refetch-and-setMessages;
 * each producer below writes the cache directly (targeted action) or triggers a cache
 * reload (staleness-guarded by the store's loadGeneration).
 *
 * NO STREAM TIER (PR 5A). `isStreaming`/`stopStreaming` used to live here as a single shared
 * SLOT, written by a claim protocol on this side and directly by GlobalAssistantView on the
 * other, and read by SidebarChatTab. That fact now lives in `usePendingStreamsStore`, read
 * via `useConversationActiveStream(channelId, conversationId)`. Selectors don't claim, so the
 * whole class is gone by construction rather than by arbitration.
 */

// ============================================
// Context Types
// ============================================

interface GlobalChatConversationContextValue {
  currentConversationId: string | null;
  isInitialized: boolean;
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

  const isInitialized = !isResolving(identity) && identity.status !== 'idle';
  const [latestGlobalConversationAdded, setLatestGlobalConversationAdded] = useState<ChatGlobalConversationAddedPayload | null>(null);


  // The id is already known — adopt it synchronously, before the messages
  // fetch even starts, so a send fired right after switching can't race.
  // Messages land in the shared conversation cache; the loader's
  // loadGeneration gate replaces the local stale-result check, and it carries
  // includeStreaming=1 so a history-tab rejoin sees the in-flight placeholder
  // row (selectRenderedMessages renders the live stream in its place).
  const loadConversation = useCallback(async (conversationId: string) => {
    dispatchIdentity({ type: 'IDENTITY_SET', conversationId });
    conversationState.setActiveConversationId(conversationId);
    await loadGlobalConversationMessages(conversationId);
  }, [dispatchIdentity]);

  const createNewConversation = useCallback(async () => {
    try {
      const newConversation = await conversationState.createAndSetActiveConversation({
        type: 'global',
      });
      if (newConversation && newConversation.id) {
        dispatchIdentity({ type: 'IDENTITY_SET', conversationId: newConversation.id });
        // A just-created conversation has no server rows — mark it loaded-empty
        // in the cache so nothing fetches for it and no loading state shows.
        conversationMessagesActions.seedConversation(newConversation.id);
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
        // CR2 (CodeRabbit round 2): everything below this await is a BOOTSTRAP
        // result, and the user may have created/selected a conversation while it
        // was in flight — their IDENTITY_SET moved the reducer past 'resolving',
        // and a stale bootstrap must not overwrite it. (loadConversation itself
        // keeps its unconditional IDENTITY_SET: a user-initiated select always
        // wins; only these post-await bootstrap adoptions are guarded.)
        if (!isResolving(identityRef.current)) return;
        if (response.ok) {
          const conversation = await response.json();
          if (!isResolving(identityRef.current)) return;
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
  // Socket reconnect — reload the active conversation's cache entry (P1).
  // The loadGeneration gate drops it if a newer load supersedes; merge-at-render
  // means it cannot blank a live stream regardless of timing.
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
      void loadGlobalConversationMessages(currentConversationIdRef.current);
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

  const { rejoinActiveStreams: rejoinGlobalStream } = useChannelStreamSocket(channelId ?? undefined, {
    // P2-P4 + P6: the shared socket-events → cache protocol (one implementation with
    // the agent channels — see buildConversationCacheHandlers for the commit/promote/
    // heal semantics). NO useChat dual-write here, unlike AiChatView: this provider
    // cannot reach the surfaces' transport instances, and post-cutover their arrays
    // are bookkeeping only — the surfaces re-seed the transport at the actions that
    // need it (retry, ask_user answers).
    ...buildConversationCacheHandlers({
      getActiveConversationId: () => currentConversationIdRef.current,
      reloadConversation: loadGlobalConversationMessages,
      refreshSnapshot: (conversationId) => refreshConversationSnapshot(null, conversationId),
    }),
    // P5: a remote tab's undo restructures the conversation wholesale — reload the
    // cache entry. Guard kept as the pure fn (cross-conversation + own-tab).
    onUndoApplied: (payload) => {
      if (!shouldRefreshAfterUndo(payload, currentConversationId, getBrowserSessionId())) return;
      void loadGlobalConversationMessages(payload.conversationId);
    },
    onGlobalConversationAdded: (payload) => {
      setLatestGlobalConversationAdded(payload);
    },
  });

  const apiEndpoint = currentConversationId ? `/api/ai/global/${currentConversationId}/messages` : '';
  const transport = useChatTransport(currentConversationId, apiEndpoint, channelId);

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
    isInitialized,
    setCurrentConversationId,
    loadConversation,
    createNewConversation,
    rejoinGlobalStream,
    latestGlobalConversationAdded,
  }), [
    setCurrentConversationId,
    currentConversationId,
    isInitialized,
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
 * Conversation identity + controls without subscribing to streaming state.
 * Best for: history panels, navigation, conversation management.
 * Messages are NOT here (PR 5B): read them via useRenderedMessages(channelId, conversationId).
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
