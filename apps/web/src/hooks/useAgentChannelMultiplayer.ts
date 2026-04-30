import { useEffect, useRef } from 'react';
import type { UIMessage } from 'ai';
import { useChannelStreamSocket } from './useChannelStreamSocket';
import { usePageSocketRoom } from './usePageSocketRoom';
import { useSocketStore } from '@/stores/useSocketStore';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { usePageAgentDashboardStore } from '@/stores/page-agents';
import { useStreamingRegistration } from '@/lib/ai/shared';
import { abortActiveStreamByMessageId } from '@/lib/ai/core/stream-abort-client';
import { synthesizeAssistantMessage } from '@/lib/ai/streams/synthesizeAssistantMessage';
import { shouldClaimAgentStopSlot } from '@/lib/ai/streams/shouldClaimAgentStopSlot';
import {
  shouldRefreshOnReconnect,
  type ConnectionStatus,
} from '@/lib/ai/streams/shouldRefreshOnReconnect';

export interface UseAgentChannelMultiplayerOptions {
  selectedAgent: { id: string } | null;
  agentConversationId: string | null;
  /** useChat-style messages setter for local synthesis on stream completion. */
  setLocalMessages: (updater: (prev: UIMessage[]) => UIMessage[]) => void;
  /** True when the surface is locally driving a stream (e.g. via useChat). */
  isLocallyStreaming: boolean;
  /** componentName for the editing-store metadata. */
  surfaceComponentName: string;
  /**
   * Re-fetch handler invoked on socket reconnect (after the initial connect).
   * Surface owns this — dashboard agent mode passes the dashboard store
   * loader, sidebar agent mode passes its own sidebar-state loader, since
   * those two surfaces resolve to different agents/conversations.
   */
  loadConversation: (conversationId: string) => void | Promise<void>;
}

/**
 * Wires a surface (GlobalAssistantView agent mode, SidebarChatTab agent mode)
 * to the multiplayer streaming pipeline for an agent's page channel:
 *
 * - Joins the agent's socket room.
 * - Bootstrap-replays in-flight streams from the DB and subscribes to live
 *   chat:stream_start / chat:stream_complete events via useChannelStreamSocket.
 * - On stream completion, synthesizes the assistant message locally and
 *   appends to the surface's useChat messages state.
 * - Single-writer-claims the dashboard store's agent stop-streaming slot when
 *   bootstrap discovers an own stream; releases only if THIS surface claimed.
 *   Co-mounted surfaces (dashboard + sidebar agent mode) preserve each
 *   other's claim — first writer wins.
 * - Registers the channel with the editing store under `ai-channel-${id}` so
 *   SWR is blocked while a stream is in flight, including the bootstrap-replay
 *   window before useChat has re-engaged.
 * - Refreshes the active conversation when the socket transitions back to
 *   connected after an offline blip (skipped on the very first connect).
 *
 * Pass `selectedAgent: null` to no-op (e.g. the surface is in global mode).
 */
export function useAgentChannelMultiplayer({
  selectedAgent,
  agentConversationId,
  setLocalMessages,
  isLocallyStreaming,
  surfaceComponentName,
  loadConversation,
}: UseAgentChannelMultiplayerOptions): void {
  const channelId = selectedAgent?.id;

  usePageSocketRoom(channelId);

  // Stable refs so the hook's callbacks see the latest setter / conversation
  // id without re-binding the socket subscription on every render.
  const setLocalMessagesRef = useRef(setLocalMessages);
  setLocalMessagesRef.current = setLocalMessages;
  const agentConversationIdRef = useRef(agentConversationId);
  agentConversationIdRef.current = agentConversationId;

  // Single-writer ownership of the dashboard store's stop slot. Only this
  // surface's onOwnStreamFinalize clears the slot, and only when this surface
  // claimed it on bootstrap. The unmount cleanup below also clears it if
  // this surface unmounts mid-stream — useChannelStreamSocket intentionally
  // does not fire onOwnStreamFinalize on teardown, so without the cleanup
  // a navigate-away mid-stream would leave the slot stuck.
  const ownedStopSlotRef = useRef(false);
  useEffect(() => {
    return () => {
      if (!ownedStopSlotRef.current) return;
      ownedStopSlotRef.current = false;
      const dashboard = usePageAgentDashboardStore.getState();
      dashboard.setAgentStreaming(false);
      dashboard.setAgentStopStreaming(null);
    };
  }, []);

  useChannelStreamSocket(channelId, {
    onStreamComplete: (messageId) => {
      const stream = usePendingStreamsStore.getState().streams.get(messageId);
      if (!stream?.text) return;
      if (stream.conversationId !== agentConversationIdRef.current) return;
      setLocalMessagesRef.current((prev) => [
        ...prev,
        synthesizeAssistantMessage(messageId, stream.text),
      ]);
    },
    onOwnStreamBootstrap: ({ messageId }) => {
      const dashboard = usePageAgentDashboardStore.getState();
      if (!shouldClaimAgentStopSlot(dashboard.agentStopStreaming)) return;
      ownedStopSlotRef.current = true;
      dashboard.setAgentStreaming(true);
      dashboard.setAgentStopStreaming(() => {
        abortActiveStreamByMessageId({ messageId });
      });
    },
    onOwnStreamFinalize: () => {
      if (!ownedStopSlotRef.current) return;
      ownedStopSlotRef.current = false;
      const dashboard = usePageAgentDashboardStore.getState();
      dashboard.setAgentStreaming(false);
      dashboard.setAgentStopStreaming(null);
    },
  });

  // Channel-id-keyed registration so co-mounted surfaces (dashboard + sidebar
  // in agent mode on the same agent) write the same key and the editing store
  // dedups same-key writes naturally. The flag ORs the surface's local
  // streaming flag with the dashboard store's bootstrap-driven flag so a
  // mid-stream refresh stays SWR-protected before useChat re-engages.
  const dashboardAgentStreaming = usePageAgentDashboardStore((s) => s.isAgentStreaming);
  useStreamingRegistration(
    selectedAgent ? `ai-channel-${selectedAgent.id}` : 'ai-channel-no-agent',
    Boolean(selectedAgent) && (isLocallyStreaming || dashboardAgentStreaming),
    selectedAgent
      ? {
          conversationId: agentConversationId || undefined,
          componentName: surfaceComponentName,
        }
      : undefined,
  );

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
}
