import { useEffect, useRef } from 'react';
import type { UIMessage } from 'ai';
import { useChannelStreamSocket } from './useChannelStreamSocket';
import { usePageSocketRoom } from './usePageSocketRoom';
import { useSocketStore } from '@/stores/useSocketStore';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { synthesizeAssistantMessage } from '@/lib/ai/streams/synthesizeAssistantMessage';
import { applyMessageEdit } from '@/lib/ai/streams/applyMessageEdit';
import { applyMessageDelete } from '@/lib/ai/streams/applyMessageDelete';
import {
  shouldRefreshOnReconnect,
  type ConnectionStatus,
} from '@/lib/ai/streams/shouldRefreshOnReconnect';
import { shouldReloadOnComountComplete } from '@/lib/ai/streams/shouldReloadOnComountComplete';

export interface UseAgentChannelMultiplayerOptions {
  selectedAgent: { id: string } | null;
  agentConversationId: string | null;
  /** useChat-style messages setter for local synthesis on stream completion. */
  setLocalMessages: (updater: (prev: UIMessage[]) => UIMessage[]) => void;
  /** True when the surface is locally driving a stream (e.g. via useChat). */
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
  loadConversation,
}: UseAgentChannelMultiplayerOptions): { rejoinActiveStreams: () => void } {
  const channelId = selectedAgent?.id;

  usePageSocketRoom(channelId);

  // Stable refs so the hook's callbacks see the latest setter / conversation
  // id without re-binding the socket subscription on every render.
  const setLocalMessagesRef = useRef(setLocalMessages);
  setLocalMessagesRef.current = setLocalMessages;
  const agentConversationIdRef = useRef(agentConversationId);
  agentConversationIdRef.current = agentConversationId;

  // NO STOP-SLOT CLAIM PROTOCOL (PR 5A, leaf 5.5.7).
  //
  // Deleted here: the claimed-messageId/claimed-key/owned-stop-fn refs, releaseStopSlotIfStillOurs,
  // its channelId-keyed cleanup, and the bootstrap/snapshot/finalize handlers that drove them.
  //
  // All of it existed to arbitrate a single shared slot in usePageAgentDashboardStore between
  // co-mounted writers — including a documented KNOWN GAP with no fix inside that design: the
  // protocol had no HANDOFF, so a surface declined the slot (first writer wins) never re-claimed
  // it once the claimant released, and could render a live own stream with NO STOP BUTTON until it
  // remounted. That gap is fixed by construction now: every surface READS
  // `useConversationActiveStream(agentId, conversationId)`, and a read cannot be declined.

  const { rejoinActiveStreams } = useChannelStreamSocket(channelId, {
    onUserMessage: (message, payload) => {
      if (payload.conversationId !== agentConversationIdRef.current) return;
      setLocalMessagesRef.current((prev) =>
        prev.some((m) => m.id === message.id) ? prev : [...prev, message],
      );
    },
    onMessageEdited: (payload) => {
      if (payload.conversationId !== agentConversationIdRef.current) return;
      setLocalMessagesRef.current((prev) =>
        applyMessageEdit(prev, {
          messageId: payload.messageId,
          parts: payload.parts,
          editedAt: new Date(payload.editedAt),
        }),
      );
    },
    onMessageDeleted: (payload) => {
      if (payload.conversationId !== agentConversationIdRef.current) return;
      setLocalMessagesRef.current((prev) => applyMessageDelete(prev, payload.messageId));
    },
    onStreamComplete: (messageId, completedConvId) => {
      const stream = usePendingStreamsStore.getState().streams.get(messageId);
      if (stream && stream.parts.length > 0 && stream.conversationId === agentConversationIdRef.current) {
        // REPLACE by id — do not skip. An existing message with this id is NOT proof we already
        // have the content.
        //
        // The server names the assistant message (`generateId: () => serverAssistantMessageId`),
        // so useChat's copy and the stream's `messageId` are the SAME id. And useChat does not
        // roll back on error: a mid-stream network drop leaves its HALF-STREAMED message sitting
        // in the array. That is exactly the path the rejoin machinery exists for — recovery
        // rejoins the multicast, `stream.parts` accumulates the FULL reply, and this fires on
        // completion.
        //
        // A skip-if-present guard therefore threw the complete reply away and left the user
        // staring at the truncated one, with the real text stranded in the DB until they
        // navigated away and back. Replacing is right in both cases: same id means same message,
        // and `stream.parts` is the authoritative, complete version of it.
        const synthesized = synthesizeAssistantMessage(messageId, stream.parts, stream.startedAt);
        setLocalMessagesRef.current((prev) => {
          const i = prev.findIndex((m) => m.id === messageId);
          return i === -1
            ? [...prev, synthesized]
            : prev.map((m, j) => (j === i ? synthesized : m));
        });
        return;
      }
      if (shouldReloadOnComountComplete(stream, completedConvId, agentConversationIdRef.current)) {
        loadConversationRef.current(completedConvId!);
      }
    },
  });

  // NO editing-store registration here (PR 5A, leaf 5.7): the one derived, conversation-keyed
  // registration for the whole app lives in GlobalChatProvider (useDerivedStreamingRegistrations).
  // This site ORed the surface's local streaming flag with the dashboard store's bootstrap-driven
  // flag precisely because neither alone covered a mid-stream refresh — the derived registration
  // reads live store entries directly, so there is nothing left to OR.

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
