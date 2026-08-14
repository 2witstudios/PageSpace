import { useCallback, useEffect, useRef } from 'react';
import { useSocket } from './useSocket';
import { useSocketStore } from '@/stores/useSocketStore';
import { useAuthStore } from '@/stores/useAuthStore';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { isOwnStream } from '@/lib/ai/streams/isOwnStream';
import { isOwnTabEcho } from '@/lib/ai/streams/isOwnTabEcho';
import {
  openStreamSession,
  completeStreamSession,
  closeChannelSessions,
  reconcileChannelSessions,
  onStreamSessionEnd,
  type StreamSessionEnd,
} from '@/lib/ai/streams/streamSessionRegistry';
import {
  shouldRefreshOnReconnect,
  type ConnectionStatus,
} from '@/lib/ai/streams/shouldRefreshOnReconnect';
import { isValidPartFrame } from '@/lib/ai/streams/isValidPartFrame';
import type {
  AiStreamStartPayload,
  AiStreamCompletePayload,
  ChatUserMessagePayload,
  ChatMessageEditedPayload,
  ChatMessageDeletedPayload,
  ChatUndoAppliedPayload,
  ChatConversationAddedPayload,
  ChatConversationRenamedPayload,
  ChatConversationDeletedPayload,
  ChatGlobalConversationAddedPayload,
  AccessRevokedPayload,
} from '@/lib/websocket/socket-utils';
import type { UIMessage } from 'ai';
import type { UIMessagePart } from '@/lib/ai/core/stream-channel-registry';

interface ActiveStreamRow {
  messageId: string;
  conversationId: string;
  /** ISO timestamp of the stream's start; stamps synthesized bubbles with a `createdAt`. */
  startedAt?: string;
  /**
   * Last debounced snapshot persisted server-side. Rendered immediately so a rejoining client
   * is not blank, then replaced wholesale by the first folded write off the channel.
   */
  parts?: UIMessagePart[];
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}

export interface UseChannelStreamSocketOptions {
  /**
   * Fires once per messageId when its stream ends.
   *
   * `info.joinFailed` means we never held an authoritative copy — usually because the stream
   * lives on another web instance whose in-process channel registry we cannot reach. The
   * stream itself was fine; we just could not watch it. The store entry has ALREADY been
   * dropped, so the consumer must reload the (durably persisted) message from the DB rather
   * than synthesize a bubble from what it has.
   *
   * `aborted` is `payload.aborted` from `chat:stream_complete` — undefined on the ends that
   * have no server-told answer to that question. Consumers that replace-in-place with
   * `synthesizeAssistantMessage` should pass `aborted ? 'interrupted' : 'complete'` so a tab
   * with the conversation open badges the interrupted state immediately.
   */
  onStreamComplete?: (
    messageId: string,
    conversationId?: string,
    info?: { joinFailed: boolean },
    aborted?: boolean,
  ) => void;
  /**
   * Fires when a remote user submits a message in this channel.
   *
   * Filters applied before invocation:
   *   1. Stale-room: events for a different `pageId` are dropped.
   *   2. Own-TAB echo: events this tab caused are dropped, because this tab already appended
   *      the message locally. Note TAB, not user — see `isOwnTabEcho` for why the user's OTHER
   *      tabs must still receive this.
   *
   * Server-side ordering: the broadcast fires AFTER `saveMessageToDatabase` resolves and
   * BEFORE the assistant `chat:stream_start` event, so consumers always see the user message
   * land before the assistant ghost text begins.
   *
   * Consumers must dedup against their existing messages by `message.id`.
   */
  onUserMessage?: (message: UIMessage, payload: ChatUserMessagePayload) => void;
  /** Remote tab edited a message here. Same stale-room + own-tab echo filter. */
  onMessageEdited?: (payload: ChatMessageEditedPayload) => void;
  /** Remote tab deleted a message here. Same stale-room + own-tab echo filter. */
  onMessageDeleted?: (payload: ChatMessageDeletedPayload) => void;
  /** Remote tab applied an AI undo here. Same stale-room + own-tab echo filter. */
  onUndoApplied?: (payload: ChatUndoAppliedPayload) => void;
  /** Remote tab created a conversation in this agent room. */
  onConversationAdded?: (payload: ChatConversationAddedPayload) => void;
  /** Remote tab renamed a conversation in this agent room. */
  onConversationRenamed?: (payload: ChatConversationRenamedPayload) => void;
  /** Remote tab deleted a conversation in this agent room. */
  onConversationDeleted?: (payload: ChatConversationDeletedPayload) => void;
  /**
   * A new global conversation was created on the user's personal channel. NO own-tab filter —
   * the history tab has no other signal and must update even for its own creations.
   */
  onGlobalConversationAdded?: (payload: ChatGlobalConversationAddedPayload) => void;
}

/**
 * Routes one channel's realtime AI events into the app-wide stream session registry.
 *
 * ── WHAT THIS HOOK STOPPED DOING, AND WHY THAT IS THE POINT ───────────────────────────────
 *
 * It used to OWN the streams: it opened the SSE joins in its effect, held their abort
 * controllers, wrote the folded parts into the store, and tore all of it down on unmount —
 * `clearPageStreams(channelId)` and every controller aborted. A generation's visible life was
 * therefore scoped to a React effect, which is how "send a message and leave" came to lose
 * the reply.
 *
 * Around that, three modules of protocol grew to make mount-scoped ownership survivable:
 * `channelStreamSubscribers` counted mounts so only the LAST one cleared the store,
 * `bootstrapConsumerGuard` claimed each messageId so co-mounted panes would not both join and
 * double-render, and `channelRebootstrapSignal` nudged a surviving sibling to re-adopt the
 * claim an unmounting one had dropped. All three are deleted. None of them was wrong; all of
 * them were compensating for a subscription that should never have lived in a component.
 *
 * Now the hook is a ROUTER. It translates socket events and the DB bootstrap into calls on
 * `streamSessionRegistry`, which owns every subscription at module scope and outlives every
 * component. Unmounting this hook detaches socket listeners and nothing else: no controller is
 * aborted, no store entry is dropped, no claim is released, and no sibling has to be told
 * anything — because nothing was ever claimed.
 *
 * `bootstrapConversationId` narrows the DB replay to ONE conversation on the channel, which is
 * what a pane wants since a pane shows exactly one. Only the bootstrap is re-keyed; the live
 * socket handlers stay channel-wide, because a `chat:stream_start` for a sibling conversation
 * still has to reach the registry. Omit it for the whole-channel form — which is what
 * `GlobalChatContext` uses so a stream stays in the store for a conversation no surface is
 * currently showing.
 */
export function useChannelStreamSocket(
  channelId: string | undefined,
  options?: UseChannelStreamSocketOptions,
  bootstrapConversationId?: string | null,
): { rejoinActiveStreams: () => void } {
  const socket = useSocket();
  // Holds the latest runBootstrap closure so rejoinActiveStreams can call it without needing
  // to be in the effect's dep array.
  const bootstrapRef = useRef<(() => void) | null>(null);

  // Stable refs so callback identity changes never trigger handler re-registration.
  const onStreamCompleteRef = useRef(options?.onStreamComplete);
  const onUserMessageRef = useRef(options?.onUserMessage);
  const onMessageEditedRef = useRef(options?.onMessageEdited);
  const onMessageDeletedRef = useRef(options?.onMessageDeleted);
  const onUndoAppliedRef = useRef(options?.onUndoApplied);
  const onConversationAddedRef = useRef(options?.onConversationAdded);
  const onConversationRenamedRef = useRef(options?.onConversationRenamed);
  const onConversationDeletedRef = useRef(options?.onConversationDeleted);
  const onGlobalConversationAddedRef = useRef(options?.onGlobalConversationAdded);
  onStreamCompleteRef.current = options?.onStreamComplete;
  onUserMessageRef.current = options?.onUserMessage;
  onMessageEditedRef.current = options?.onMessageEdited;
  onMessageDeletedRef.current = options?.onMessageDeleted;
  onUndoAppliedRef.current = options?.onUndoApplied;
  onConversationAddedRef.current = options?.onConversationAdded;
  onConversationRenamedRef.current = options?.onConversationRenamed;
  onConversationDeletedRef.current = options?.onConversationDeleted;
  onGlobalConversationAddedRef.current = options?.onGlobalConversationAdded;

  // Forward the registry's app-wide end notifications for THIS channel.
  //
  // Separate from the socket effect on purpose. A session can end for reasons the socket
  // never mentions — the SSE join resolving, the poll fallback noticing the row vanish, a
  // bootstrap reconciliation — and every one of those has to reach the consumer's
  // reload-from-DB branch. Keying the forwarder on the socket instance would silently drop
  // them across an `auth:refreshed` reconnect, which mints a brand-new `io()`.
  useEffect(() => {
    if (!channelId) return;
    return onStreamSessionEnd((end: StreamSessionEnd) => {
      if (end.channelId !== channelId) return;
      onStreamCompleteRef.current?.(
        end.messageId,
        end.conversationId,
        { joinFailed: end.joinFailed },
        end.aborted,
      );
    });
  }, [channelId]);

  useEffect(() => {
    if (!socket || !channelId) return;

    let cancelled = false;
    const localBrowserSessionId = getBrowserSessionId();
    // Narrowed once. `channelId` is `string | undefined` at the hook's boundary and the guard
    // above proves it here, but that narrowing does not survive into the async bootstrap
    // closure — so bind it rather than re-asserting at each use.
    const channel = channelId;

    /**
     * WHOSE stream is this? A USER's, never a tab's.
     *
     * Read at EVENT time rather than captured, because auth hydrates asynchronously and a
     * value captured when the effect ran can be `undefined` for the first events on a fresh
     * load — which would classify the user's own stream as a stranger's for the rest of the
     * channel subscription. `isOwnStream` fails closed on an absent id, so the cost of
     * reading it late is nothing and the cost of reading it early is a Stop button that
     * never appears.
     */
    const localUserId = (): string | undefined => useAuthStore.getState().user?.id;

    // Re-running is idempotent: `openStreamSession` no-ops on a messageId already being
    // watched, so mount, the reconnect effect, and rejoinActiveStreams can all trigger this
    // independently without opening a second join.
    //
    // Responses are not ordered, and only the newest run's snapshot is authoritative — a slow
    // older response landing after a newer one carries a stale view of what is live, and
    // reconciling against it would tear down a session that started in between.
    let bootstrapGeneration = 0;

    const runBootstrap = async () => {
      const generation = (bootstrapGeneration += 1);
      // Stamped BEFORE the request leaves. `/active-streams` answers about the world as it was
      // when the query ran, so anything that starts during the round trip is outside what this
      // answer can speak about — see `ReconcileScope.snapshotTakenAt`.
      const snapshotTakenAt = Date.now();
      try {
        const conversationScope = bootstrapConversationId
          ? `&conversationId=${encodeURIComponent(bootstrapConversationId)}`
          : '';
        const res = await fetchWithAuth(
          `/api/ai/chat/active-streams?channelId=${encodeURIComponent(channel)}${conversationScope}`,
          { credentials: 'include' },
        );
        if (cancelled) return;
        if (!res.ok) return;
        const data = (await res.json()) as { streams?: ActiveStreamRow[] };
        if (cancelled) return;

        for (const stream of data.streams ?? []) {
          // `isValidPartFrame` applies the same wire-trust gate the live path applies. Nothing
          // else: the snapshot is ALREADY the finished reduction — the server writes
          // `foldChunksToParts(frames)` — so it is seeded verbatim rather than re-reduced
          // through a fold over CHUNKS, which would run two text blocks together.
          const seedParts = (stream.parts ?? []).filter(isValidPartFrame);
          openStreamSession({
            messageId: stream.messageId,
            conversationId: stream.conversationId,
            channelId: channel,
            triggeredBy: {
              userId: stream.triggeredBy.userId,
              displayName: stream.triggeredBy.displayName,
            },
            isOwn: isOwnStream(stream.triggeredBy, localUserId()),
            startedAt: stream.startedAt ?? new Date().toISOString(),
            seedParts,
          });
        }

        // The server's word on what is still running. A session we hold that is NOT in this
        // list lost its terminal event; reconciling drops it and tells consumers to reload,
        // rather than leaving it to the registry's hour-long expiry sweep. Superseded runs
        // stay silent — their answer is stale, and acting on it would tear down live sessions.
        //
        // SCOPED TO THE SAME QUESTION THIS BOOTSTRAP ASKED. When `bootstrapConversationId` is
        // set the response lists ONE conversation's streams, so reconciling channel-wide
        // against it reports every sibling conversation as finished — mounting conversation A
        // would tear down conversation B mid-generation. See `reconcileChannelSessions`.
        if (generation === bootstrapGeneration) {
          reconcileChannelSessions(
            channel,
            new Set((data.streams ?? []).map((stream) => stream.messageId)),
            {
              ...(bootstrapConversationId ? { conversationId: bootstrapConversationId } : {}),
              snapshotTakenAt,
            },
          );
        }
      } catch (err) {
        if (cancelled) return;
        console.warn('[useChannelStreamSocket] bootstrap failed', err);
      }
    };

    bootstrapRef.current = runBootstrap;
    void runBootstrap();

    const handleStreamStart = (payload: AiStreamStartPayload) => {
      if (payload.pageId !== channelId) return;
      // NO "am I already consuming this?" GATE any more, and there is nothing left for one to
      // guard. It existed because the originating tab read its own tokens off the POST body,
      // so also joining the multicast rendered every token twice — `consumingChannels` +
      // `shouldAttachStream` were that check. Under detached mode nobody reads a body: the
      // sender's own send opens a session through this same registry, keyed by the same
      // messageId, and `openStreamSession` is idempotent. One channel, one subscription, by
      // construction rather than by bookkeeping.
      //
      // /stream-join re-authorizes every join with `canAccessConversation` server-side, so
      // attaching optimistically here widens nothing; a refused join is a quiet 404 the
      // registry handles benignly.
      openStreamSession({
        messageId: payload.messageId,
        conversationId: payload.conversationId,
        channelId: channel,
        triggeredBy: {
          userId: payload.triggeredBy.userId,
          displayName: payload.triggeredBy.displayName,
        },
        isOwn: isOwnStream(payload.triggeredBy, localUserId()),
        // Optional on the wire for cross-version safety: during a rolling deploy an
        // originator on the previous build emits this event without it. Falling back to
        // "now" keeps the bubble's ordering sane AND — more importantly — gives the
        // registry's expiry sweep a timestamp to work from, since a session with no
        // parseable start would otherwise be the one entry that could never age out.
        startedAt: payload.startedAt ?? new Date().toISOString(),
      });
    };

    const handleStreamComplete = (payload: AiStreamCompletePayload) => {
      if (payload.pageId !== channelId) return;
      completeStreamSession({
        messageId: payload.messageId,
        // Optional on the wire (same rolling-deploy reason as `startedAt`). The registry
        // prefers the session's own id and uses this only as the fallback for a stream this
        // tab was never watching.
        conversationId: payload.conversationId,
        channelId: channel,
        aborted: payload.aborted,
      });
    };

    const handleUserMessage = (payload: ChatUserMessagePayload) => {
      if (payload.pageId !== channelId) return;
      if (isOwnTabEcho(payload.triggeredBy, localBrowserSessionId)) return;
      onUserMessageRef.current?.(payload.message, payload);
    };

    const handleMessageEdited = (payload: ChatMessageEditedPayload) => {
      if (payload.pageId !== channelId) return;
      if (isOwnTabEcho(payload.triggeredBy, localBrowserSessionId)) return;
      onMessageEditedRef.current?.(payload);
    };

    const handleMessageDeleted = (payload: ChatMessageDeletedPayload) => {
      if (payload.pageId !== channelId) return;
      if (isOwnTabEcho(payload.triggeredBy, localBrowserSessionId)) return;
      onMessageDeletedRef.current?.(payload);
    };

    const handleUndoApplied = (payload: ChatUndoAppliedPayload) => {
      if (payload.pageId !== channelId) return;
      if (isOwnTabEcho(payload.triggeredBy, localBrowserSessionId)) return;
      onUndoAppliedRef.current?.(payload);
    };

    const handleConversationAdded = (payload: ChatConversationAddedPayload) => {
      if (payload.agentId !== channelId) return;
      if (isOwnTabEcho(payload.triggeredBy, localBrowserSessionId)) return;
      onConversationAddedRef.current?.(payload);
    };

    const handleConversationRenamed = (payload: ChatConversationRenamedPayload) => {
      if (payload.agentId !== channelId) return;
      if (isOwnTabEcho(payload.triggeredBy, localBrowserSessionId)) return;
      onConversationRenamedRef.current?.(payload);
    };

    const handleConversationDeleted = (payload: ChatConversationDeletedPayload) => {
      if (payload.agentId !== channelId) return;
      if (isOwnTabEcho(payload.triggeredBy, localBrowserSessionId)) return;
      onConversationDeletedRef.current?.(payload);
    };

    const handleGlobalConversationAdded = (payload: ChatGlobalConversationAddedPayload) => {
      // No own-tab filter: the history tab must update even when the conversation was created
      // in this tab (it has no other signal).
      onGlobalConversationAddedRef.current?.(payload);
    };

    // The realtime server emits this on permission revocation using the channel room id
    // directly, so `room` is the channelId.
    const handleAccessRevoked = (payload: AccessRevokedPayload) => {
      if (payload.room !== channelId) return;
      // Tear the sessions down WITHOUT reporting completions: nothing finished, and telling
      // consumers otherwise would have them reload messages the user may no longer read.
      closeChannelSessions(channel);
    };

    socket.on('chat:stream_start', handleStreamStart);
    socket.on('chat:stream_complete', handleStreamComplete);
    socket.on('chat:user_message', handleUserMessage);
    socket.on('chat:message_edited', handleMessageEdited);
    socket.on('chat:message_deleted', handleMessageDeleted);
    socket.on('chat:undo_applied', handleUndoApplied);
    socket.on('chat:conversation_added', handleConversationAdded);
    socket.on('chat:conversation_renamed', handleConversationRenamed);
    socket.on('chat:conversation_deleted', handleConversationDeleted);
    socket.on('chat:global_conversation_added', handleGlobalConversationAdded);
    socket.on('access_revoked', handleAccessRevoked);

    return () => {
      // DETACH LISTENERS. THAT IS ALL.
      //
      // No controller is aborted, no store entry is dropped, no claim is released, and no
      // sibling is nudged to reclaim anything. Everything this cleanup used to do was in
      // service of subscriptions this hook no longer owns — the registry does, at module
      // scope, and a component going away is not evidence that a generation stopped.
      //
      // `cancelled` still exists for exactly one reason: an in-flight bootstrap fetch must not
      // apply its result after teardown, because `reconcileChannelSessions` acts on a
      // channel-wide view and a late one could tear down sessions a REMOUNT has since opened.
      cancelled = true;
      socket.off('chat:stream_start', handleStreamStart);
      socket.off('chat:stream_complete', handleStreamComplete);
      socket.off('chat:user_message', handleUserMessage);
      socket.off('chat:message_edited', handleMessageEdited);
      socket.off('chat:message_deleted', handleMessageDeleted);
      socket.off('chat:undo_applied', handleUndoApplied);
      socket.off('chat:conversation_added', handleConversationAdded);
      socket.off('chat:conversation_renamed', handleConversationRenamed);
      socket.off('chat:conversation_deleted', handleConversationDeleted);
      socket.off('chat:global_conversation_added', handleGlobalConversationAdded);
      socket.off('access_revoked', handleAccessRevoked);
    };
    // `bootstrapConversationId` is in the deps because it changes which streams the DB replay
    // covers: a pane switching conversations must re-bootstrap.
  }, [socket, channelId, bootstrapConversationId]);

  // Stable callback; the ref always points at the latest runBootstrap closure.
  const rejoinActiveStreams = useCallback(() => {
    bootstrapRef.current?.();
  }, []);

  // Re-bootstrap on socket reconnect. The effect above keys on [socket, channelId], and
  // socket.io reconnects the SAME instance in place — so without this, a connection drop
  // silently costs us every `chat:stream_start` emitted while we were away, and the tab stays
  // blind to a live stream until it is reloaded.
  const socketConnectionStatus = useSocketStore((s) => s.connectionStatus);
  const prevConnectionStatusRef = useRef<ConnectionStatus | null>(null);
  const hasInitialConnectRef = useRef(false);
  useEffect(() => {
    if (!channelId) return;
    const prev = prevConnectionStatusRef.current;
    prevConnectionStatusRef.current = socketConnectionStatus;
    if (shouldRefreshOnReconnect(prev, socketConnectionStatus, hasInitialConnectRef.current)) {
      bootstrapRef.current?.();
    }
    if (prev !== 'connected' && socketConnectionStatus === 'connected') {
      hasInitialConnectRef.current = true;
    }
  }, [channelId, socketConnectionStatus]);

  return { rejoinActiveStreams };
}
