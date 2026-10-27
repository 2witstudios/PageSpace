import { useEffect, useRef } from 'react';
import { usePageSocketRoom } from './usePageSocketRoom';
import { useSocketStore } from '@/stores/useSocketStore';
import {
  shouldRefreshOnReconnect,
  type ConnectionStatus,
} from '@/lib/ai/streams/shouldRefreshOnReconnect';
import { useConversationSubscription } from '@/hooks/useConversationSubscription';

export interface UseAgentChannelMultiplayerOptions {
  selectedAgent: { id: string } | null;
  agentConversationId: string | null;
  /**
   * Re-fetch handler invoked on socket reconnect (after the initial connect).
   * Surface owns this — dashboard agent mode passes the dashboard store loader,
   * sidebar agent mode passes its own sidebar-state loader, since those two
   * surfaces resolve to different agents/conversations. Both commit to the
   * shared conversation cache (PR 5B).
   */
  loadConversation: (conversationId: string) => void | Promise<void>;
}

/**
 * THIN WRAPPER over `useConversationSubscription` (Agent-Session Single Source
 * of Truth epic, Phase 2 / plan PR 3).
 *
 * This hook used to BE the agent-channel multiplayer path: it owned the cache
 * handlers, the channel bootstrap and the reconnect refresh. All three moved —
 * a surface now subscribes to the CONVERSATION it is showing (joining
 * `conv:<id>`, holding a rev watermark, applying authoritative
 * `conversation:*` events) rather than to a page channel it happens to share
 * with other people's private threads. What survives here is the shape its
 * three call sites already pass, plus the two things that are genuinely
 * channel-scoped:
 *
 *  - `usePageSocketRoom(channelId)` — the legacy page room, still the audience
 *    for the `chat:*` events the server emits in parallel during the migration
 *    window (a later contract PR deletes those emissions and this line with
 *    them);
 *  - the surface-supplied reconnect refresh, which cannot move into the
 *    subscription because the two consuming surfaces resolve their agent state
 *    from different stores and one shared loader would refresh the wrong
 *    conversation in the other.
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

  // NO STOP-SLOT CLAIM PROTOCOL (PR 5A, leaf 5.5.7) — every surface READS
  // `useConversationActiveStream(agentId, conversationId)`, and a read cannot be declined.
  //
  // NO editing-store registration here (PR 5A, leaf 5.7): the one derived,
  // conversation-keyed registration for the whole app lives in GlobalChatProvider
  // (useDerivedStreamingRegistrations).
  const { rejoinActiveStreams } = useConversationSubscription(agentConversationId, {
    channelId,
    agentPageId: channelId ?? null,
  });

  // Reconnect-refresh: re-fetch the active agent conversation when the socket
  // transitions back to connected. Skipped on the very first connect (already
  // covered by mount-time load). Complements — does not duplicate — the
  // subscription's own batched rev check: that one heals the CACHE for every
  // watched conversation, this one is the surface's chance to re-derive its own
  // identity-bearing state through its own loader.
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
