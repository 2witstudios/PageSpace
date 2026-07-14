import { useEffect, useRef } from 'react';
import type { UIMessage } from 'ai';
import { useChannelStreamSocket } from './useChannelStreamSocket';
import { usePageSocketRoom } from './usePageSocketRoom';
import { useSocketStore } from '@/stores/useSocketStore';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import {
  usePageAgentDashboardStore,
  selectIsAgentStreaming,
  agentStreamKey,
  type AgentStreamKey,
} from '@/stores/page-agents';
import { useStreamingRegistration } from '@/lib/ai/shared';
import { abortActiveStreamByMessageId } from '@/lib/ai/core/stream-abort-client';
import { synthesizeAssistantMessage } from '@/lib/ai/streams/synthesizeAssistantMessage';
import { shouldClaimAgentStopSlot } from '@/lib/ai/streams/shouldClaimAgentStopSlot';
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
}: UseAgentChannelMultiplayerOptions): { rejoinActiveStreams: () => void } {
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
  // The messageId this surface claimed the slot FOR — not a bare boolean. A channel can
  // carry two of this user's own streams at once (send, then New Chat while it runs), and
  // only one of them holds the slot. With a boolean, the OTHER one's finalize would
  // release the slot out from under the stream that actually owns it, killing a live
  // Stop button. `onOwnStreamBootstrap` can also decline to claim (conversation
  // mismatch), while `ownStreamIds` still registers the stream for finalization — so a
  // declined stream must never be able to release anything.
  const ownedStopSlotRef = useRef<string | null>(null);
  // The exact stop function we installed. Releasing on "I claimed once" is not enough:
  // the slot is a single shared singleton, and GlobalAssistantView writes it directly
  // from its own local status without going through the claim protocol. So by the time we
  // release, the slot may belong to somebody else — and nulling it then would kill THEIR
  // live Stop button and their isAgentStreaming flag. Only release what is still ours.
  const ownedStopFnRef = useRef<(() => void) | null>(null);
  // The agent we claimed FOR — not the agent we happen to be on now. The release can run
  // from a cleanup triggered by an agent switch, where `channelId` has already moved on;
  // clearing the flag against the new agent would leave the OLD one's flag set forever.
  // The KEY we claimed for — (agent, conversation), not just the agent, and not the agent we
  // happen to be on now (a cleanup fired by an agent switch has already moved on).
  const ownedKeyRef = useRef<AgentStreamKey | null>(null);

  // KNOWN GAP (pre-existing, unchanged by this hook's messageId scoping): the claim
  // protocol has no HANDOFF. If a co-mounted surface was declined the slot (first writer
  // wins) and the claimant later releases it, the declined surface does not re-claim — so
  // it can render a live own stream with no Stop button until it remounts. Closing this
  // needs a re-claim protocol on the dashboard store (subscribe to the slot, re-claim when
  // it frees and our stream is still in flight), which is a change to that store's
  // contract rather than to stream ownership. Deliberately left for a follow-up.
  const releaseStopSlotIfStillOurs = () => {
    if (ownedStopSlotRef.current === null) return;
    const dashboard = usePageAgentDashboardStore.getState();
    // A null slot is FREE, not foreign. GlobalAssistantView nulls the stop fn on ordinary
    // paths (its effect's else-branch and cleanup, whenever agentStatus is 'ready' — which
    // it is for the whole life of a BOOTSTRAPPED stream) without touching isAgentStreaming.
    // Treating that as "not ours" would skip setAgentStreaming(false) and strand it true.
    // A DIFFERENT fn means another, live stream owns the slot — leave both halves alone.
    // A NULL slot means nobody owns it: it is free, and still ours to clear.
    const claimedKey = ownedKeyRef.current;
    const k = claimedKey === null ? null : agentStreamKey(claimedKey);
    const ownedStopFn = ownedStopFnRef.current;
    // Clear our refs FIRST, unconditionally — whatever we decide below, we no longer hold a
    // claim, and an early return must never leave them dangling.
    ownedStopSlotRef.current = null;
    ownedStopFnRef.current = null;
    ownedKeyRef.current = null;
    if (claimedKey === null || k === null) return;
    // Identity-guarded WITHIN the key: GlobalAssistantView installs its own local stop for
    // this same (agent, conversation) and would otherwise have ours clobbered. Collisions
    // across different streams are impossible by construction — the state is keyed per stream.
    const current = dashboard.agentStops[k];
    const stillOurs = current === ownedStopFn || current === undefined;
    if (!stillOurs) return;
    dashboard.setAgentStreaming(claimedKey, false);
    dashboard.setAgentStop(claimedKey, null);
  };
  const releaseStopSlotRef = useRef(releaseStopSlotIfStillOurs);
  releaseStopSlotRef.current = releaseStopSlotIfStillOurs;
  // Keyed on channelId, NOT []. `channelId` is `selectedAgent?.id`, and the sidebar swaps
  // agents in place without unmounting — while useChannelStreamSocket's effect (deps
  // [socket, channelId]) tears down on that same change and, by design, does NOT fire
  // onOwnStreamFinalize. A []-keyed cleanup would therefore never run, leaving the claim
  // behind: the next agent's own stream would find the slot occupied and decline it, its
  // finalize would not match the stale messageId, and the dashboard would be stuck
  // `isAgentStreaming: true` with a Stop button wired to the previous agent's dead
  // message. (The old boolean ref accidentally recovered from this — any own finalize
  // released it — so scoping the release by messageId without this would be a regression.)
  useEffect(() => {
    return () => {
      releaseStopSlotRef.current();
    };
  }, [channelId]);

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
    onOwnStreamBootstrap: ({ messageId, conversationId }) => {
      // Conversation-scoped, same reasoning as the remote-stream filter: a channel
      // carries every conversation's streams, so an own stream in conversation X must
      // not make conversation Y render as streaming with a Stop button that aborts X.
      // Only reject a KNOWN mismatch — the DB bootstrap can land before the surface has
      // resolved its conversation, and rejecting on a null id there would drop the very
      // stream it is about to render.
      const activeId = agentConversationIdRef.current;
      if (activeId !== null && conversationId !== activeId) return;
      const dashboard = usePageAgentDashboardStore.getState();
      if (!channelId) return;
      // Keyed by the STREAM's OWN conversation — not the surface's active one. That is what
      // lets the bootstrap claim land before identity resolves without owning the wrong
      // thing: the claim names its own stream, and a reader asking about a different
      // conversation simply never sees it.
      const claimKey: AgentStreamKey = { agentId: channelId, conversationId };
      const claimK = agentStreamKey(claimKey);
      if (claimK === null) return;
      if (!shouldClaimAgentStopSlot(dashboard.agentStops[claimK] ?? null)) return;
      const stopFn = () => {
        abortActiveStreamByMessageId({ messageId });
      };
      ownedStopSlotRef.current = messageId;
      ownedStopFnRef.current = stopFn;
      ownedKeyRef.current = claimKey;
      dashboard.setAgentStreaming(claimKey, true);
      dashboard.setAgentStop(claimKey, stopFn);
    },
    // A claim is only ever released by onOwnStreamFinalize — and there are paths where
    // that event never fires (the socket effect tears down without finalizing on a
    // socket-instance swap; if the stream ended in that gap, nothing announces it). The
    // flag would strand true: a Stop button over a dead stream, plus permanent SWR
    // suppression via useStreamingRegistration. Bootstrap knows the truth, so reconcile.
    onActiveStreamsSnapshot: (liveMessageIds) => {
      const claimed = ownedStopSlotRef.current;
      if (claimed === null || liveMessageIds.has(claimed)) return;
      releaseStopSlotRef.current();
    },
    onOwnStreamFinalize: ({ messageId }) => {
      // Only the stream that actually claimed the slot may release it — and only if the
      // slot still holds our stop function (see releaseStopSlotIfStillOurs).
      if (ownedStopSlotRef.current !== messageId) return;
      releaseStopSlotRef.current();
    },
  });

  // Channel-id-keyed registration so co-mounted surfaces (dashboard + sidebar
  // in agent mode on the same agent) write the same key and the editing store
  // dedups same-key writes naturally. The flag ORs the surface's local
  // streaming flag with the dashboard store's bootstrap-driven flag so a
  // mid-stream refresh stays SWR-protected before useChat re-engages.
  // Scoped to OUR agent — the dashboard slot is shared with a surface that may hold another.
  const dashboardAgentStreaming = usePageAgentDashboardStore(
    selectIsAgentStreaming({ agentId: channelId, conversationId: agentConversationId }),
  );
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

  return { rejoinActiveStreams };
}
