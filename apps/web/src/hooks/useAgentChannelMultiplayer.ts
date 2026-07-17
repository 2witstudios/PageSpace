import { useEffect, useMemo, useRef } from 'react';
import { useChannelStreamSocket } from './useChannelStreamSocket';
import { usePageSocketRoom } from './usePageSocketRoom';
import { useSocketStore } from '@/stores/useSocketStore';
import {
  shouldRefreshOnReconnect,
  type ConnectionStatus,
} from '@/lib/ai/streams/shouldRefreshOnReconnect';
import {
  loadAgentConversationMessages,
  refreshConversationSnapshot,
} from '@/hooks/conversationMessagesLoaders';
import { buildConversationCacheHandlers } from '@/hooks/conversationCacheSocketHandlers';

export interface UseAgentChannelMultiplayerOptions {
  selectedAgent: { id: string } | null;
  agentConversationId: string | null;
  /**
   * Re-fetch handler invoked on socket reconnect (after the initial connect)
   * and when a completion has no usable store entry to commit. Surface owns
   * this — dashboard agent mode passes the dashboard store loader, sidebar
   * agent mode passes its own sidebar-state loader, since those two surfaces
   * resolve to different agents/conversations. Both commit to the shared
   * conversation cache (PR 5B).
   */
  loadConversation: (conversationId: string) => void | Promise<void>;
}

/**
 * Wires a surface (GlobalAssistantView agent mode, SidebarChatTab agent mode)
 * to the multiplayer streaming pipeline for an agent's page channel — the
 * agent-mode twin of the global path in GlobalChatContext (PR 5B, leaf 5.6):
 *
 * - Joins the agent's socket room.
 * - Bootstrap-replays in-flight streams from the DB and subscribes to live
 *   chat:stream_start / chat:stream_complete events via useChannelStreamSocket.
 * - Message callbacks write the shared conversation cache directly — there is
 *   no `setLocalMessages` and no transport-array write left here. That also
 *   removes the whole "foreign message lands in the array the own-stream
 *   mirror reads" hazard this hook's completion handler used to gate on
 *   `stream.isOwn` for: the cache write is safe for ANY stream (a second
 *   tab's included) because nothing derives stream identity from the cache.
 * - Refreshes the active conversation when the socket transitions back to
 *   connected after an offline blip (skipped on the very first connect).
 *
 * Both consuming surfaces can be co-mounted on the same conversation; every
 * cache action here is idempotent (append-if-absent / upsert-by-id), so the
 * duplicate delivery is harmless by construction.
 *
 * Pass `selectedAgent: null` to no-op (e.g. the surface is in global mode).
 */
export function useAgentChannelMultiplayer({
  selectedAgent,
  agentConversationId,
  loadConversation,
}: UseAgentChannelMultiplayerOptions): { rejoinActiveStreams: () => void } {
  const channelId = selectedAgent?.id;

  usePageSocketRoom(channelId);

  // Stable ref so the hook's callbacks see the latest conversation id without
  // re-binding the socket subscription on every render.
  const agentConversationIdRef = useRef(agentConversationId);
  agentConversationIdRef.current = agentConversationId;

  // NO STOP-SLOT CLAIM PROTOCOL (PR 5A, leaf 5.5.7) — every surface READS
  // `useConversationActiveStream(agentId, conversationId)`, and a read cannot be declined.

  // The shared socket-events → cache protocol (see buildConversationCacheHandlers):
  // remote user/edit/delete writes, and the completion commit with own-send
  // promotion + background snapshot heal. Cache reloads here use the RAW loaders
  // keyed by the channel (agent page id) — never the surface's loadConversation,
  // which also sets identity and pushes the URL; a completion for the conversation
  // already on screen must not do either.
  const cacheHandlers = useMemo(
    () =>
      buildConversationCacheHandlers({
        getActiveConversationId: () => agentConversationIdRef.current,
        reloadConversation: (conversationId) => {
          if (channelId) void loadAgentConversationMessages(channelId, conversationId);
        },
        refreshSnapshot: (conversationId) => {
          if (channelId) void refreshConversationSnapshot(channelId, conversationId);
        },
      }),
    [channelId],
  );

  const { rejoinActiveStreams } = useChannelStreamSocket(channelId, cacheHandlers);

  // NO editing-store registration here (PR 5A, leaf 5.7): the one derived, conversation-keyed
  // registration for the whole app lives in GlobalChatProvider (useDerivedStreamingRegistrations).

  // Reconnect-refresh: re-fetch the active agent conversation when the socket
  // transitions back to connected. Skipped on the very first connect (already
  // covered by mount-time load). Uses the surface-provided loadConversation
  // because the two consuming surfaces (dashboard agent mode + sidebar agent
  // mode) resolve their agent state from different stores; one shared loader
  // would refresh the wrong conversation in the other surface.
  const socketConnectionStatus = useSocketStore((s) => s.connectionStatus);
  const prevConnectionStatusRef = useRef<ConnectionStatus | null>(null);
  const hasInitialConnectRef = useRef(false);
  const loadConversationRef = useRef(loadConversation);
  loadConversationRef.current = loadConversation;
  useEffect(() => {
    if (!selectedAgent) return;
    const prev = prevConnectionStatusRef.current;
    prevConnectionStatusRef.current = socketConnectionStatus;
    if (
      shouldRefreshOnReconnect(prev, socketConnectionStatus, hasInitialConnectRef.current)
      && agentConversationId
    ) {
      loadConversationRef.current(agentConversationId);
    }
    if (prev !== 'connected' && socketConnectionStatus === 'connected') {
      hasInitialConnectRef.current = true;
    }
  }, [selectedAgent, socketConnectionStatus, agentConversationId]);

  return { rejoinActiveStreams };
}
