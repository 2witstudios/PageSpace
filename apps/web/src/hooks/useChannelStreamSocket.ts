import { useCallback, useEffect, useRef } from 'react';
import { useSocket } from './useSocket';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { consumeStreamJoin } from '@/lib/ai/core/stream-join-client';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { isOwnStream } from '@/lib/ai/streams/isOwnStream';
import { shouldSkipBootstrappedStream } from '@/lib/ai/streams/shouldSkipBootstrappedStream';
import { claimBootstrapConsumer, releaseBootstrapConsumer } from '@/lib/ai/streams/bootstrapConsumerGuard';
import { isValidPartFrame } from '@/lib/ai/streams/isValidPartFrame';
import { appendPart as appendPartPure } from '@/lib/ai/streams/appendPart';
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
import type { UIMessagePart } from '@/lib/ai/core/stream-multicast-registry';

interface ActiveStreamRow {
  messageId: string;
  conversationId: string;
  /** ISO timestamp of the stream's start; stamps synthesized bubbles with a `createdAt`. */
  startedAt?: string;
  /** Last debounced snapshot persisted server-side — a prefix of the live multicast buffer, if still alive. */
  parts?: UIMessagePart[];
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}

export interface UseChannelStreamSocketOptions {
  /** Fires once per messageId on clean finalize (SSE resolve or socket complete); NOT on SSE error. */
  onStreamComplete?: (messageId: string, conversationId?: string) => void;
  /** Fires once per messageId when DB bootstrap finds an in-flight stream from this browser session. */
  onOwnStreamBootstrap?: (event: { messageId: string }) => void;
  /** Fires once per own-bootstrapped messageId on any finalize path (resolve, complete, or error). */
  onOwnStreamFinalize?: (event: { messageId: string }) => void;
  /**
   * Fires when a remote user submits a message in this channel.
   *
   * Filters applied before invocation:
   *   1. Stale-room: events for a different `pageId` are dropped.
   *   2. Own-tab dedup: events whose `triggeredBy.browserSessionId` matches
   *      the local session are dropped (the originator's `useChat` already
   *      appended the message locally).
   *
   * Server-side ordering: the broadcast fires AFTER `saveMessageToDatabase`
   * resolves and BEFORE the assistant `chat:stream_start` event, so consumers
   * always see the user message land before the assistant ghost text begins.
   *
   * Consumers must dedup against their existing messages by `message.id`
   * (the bootstrap REST GET may also surface the message if it ran after
   * the save and before the broadcast was processed locally).
   */
  onUserMessage?: (message: UIMessage, payload: ChatUserMessagePayload) => void;
  /**
   * Fires when a remote tab edits a message in this channel. Same stale-room
   * + own-tab dedup as `onUserMessage`. Consumers should still apply a
   * conversation-id guard before mutating their local messages.
   */
  onMessageEdited?: (payload: ChatMessageEditedPayload) => void;
  /**
   * Fires when a remote tab deletes a message in this channel. Same stale-room
   * + own-tab dedup as `onUserMessage`. Consumers should still apply a
   * conversation-id guard before mutating their local messages.
   */
  onMessageDeleted?: (payload: ChatMessageDeletedPayload) => void;
  /**
   * Fires when a remote tab applies an AI undo on this channel. Same stale-room
   * + own-tab dedup as `onUserMessage`. Surfaces typically respond by
   * refreshing the conversation, gated by `shouldRefreshAfterUndo` so a
   * cross-conversation undo doesn't disturb the active surface.
   */
  onUndoApplied?: (payload: ChatUndoAppliedPayload) => void;
  /**
   * Fires when a remote tab creates a new conversation in this agent room.
   * Same stale-room (`agentId !== channelId`) + own-tab dedup as
   * `onUserMessage`. Surfaces typically respond by prepending the
   * conversation to their history list, gated by `shouldPrependConversation`.
   */
  onConversationAdded?: (payload: ChatConversationAddedPayload) => void;
  /**
   * Fires when a remote tab renames a conversation in this agent room.
   * Same stale-room (`agentId !== channelId`) + own-tab dedup as
   * `onConversationAdded`.
   */
  onConversationRenamed?: (payload: ChatConversationRenamedPayload) => void;
  /**
   * Fires when a remote tab deletes a conversation in this agent room.
   * Same stale-room (`agentId !== channelId`) + own-tab dedup as
   * `onConversationAdded`.
   */
  onConversationDeleted?: (payload: ChatConversationDeletedPayload) => void;
  /**
   * Fires when a new global (non-agent) conversation is created on the user's
   * personal channel. No own-tab dedup — the history tab has no other signal
   * and needs to update even when the conversation originated in this tab.
   */
  onGlobalConversationAdded?: (payload: ChatGlobalConversationAddedPayload) => void;
}

/** Subscribes a component to a channel's AI streaming lifecycle: DB-replay on mount, live socket events, SSE join, store cleanup on unmount. Pass `undefined` channelId to no-op. */
export function useChannelStreamSocket(
  channelId: string | undefined,
  options?: UseChannelStreamSocketOptions,
): { rejoinActiveStreams: () => void } {
  const socket = useSocket();
  // Holds the latest runBootstrap closure so rejoinActiveStreams can call it without
  // needing to be in the effect's dep array (the effect re-creates this on every run).
  const bootstrapRef = useRef<(() => void) | null>(null);
  // Stable refs so callback identity changes never trigger handler re-registration.
  const onStreamCompleteRef = useRef(options?.onStreamComplete);
  const onOwnStreamBootstrapRef = useRef(options?.onOwnStreamBootstrap);
  const onOwnStreamFinalizeRef = useRef(options?.onOwnStreamFinalize);
  const onUserMessageRef = useRef(options?.onUserMessage);
  const onMessageEditedRef = useRef(options?.onMessageEdited);
  const onMessageDeletedRef = useRef(options?.onMessageDeleted);
  const onUndoAppliedRef = useRef(options?.onUndoApplied);
  const onConversationAddedRef = useRef(options?.onConversationAdded);
  const onConversationRenamedRef = useRef(options?.onConversationRenamed);
  const onConversationDeletedRef = useRef(options?.onConversationDeleted);
  const onGlobalConversationAddedRef = useRef(options?.onGlobalConversationAdded);
  onStreamCompleteRef.current = options?.onStreamComplete;
  onOwnStreamBootstrapRef.current = options?.onOwnStreamBootstrap;
  onOwnStreamFinalizeRef.current = options?.onOwnStreamFinalize;
  onUserMessageRef.current = options?.onUserMessage;
  onMessageEditedRef.current = options?.onMessageEdited;
  onMessageDeletedRef.current = options?.onMessageDeleted;
  onUndoAppliedRef.current = options?.onUndoApplied;
  onConversationAddedRef.current = options?.onConversationAdded;
  onConversationRenamedRef.current = options?.onConversationRenamed;
  onConversationDeletedRef.current = options?.onConversationDeleted;
  onGlobalConversationAddedRef.current = options?.onGlobalConversationAdded;

  useEffect(() => {
    if (!socket || !channelId) return;

    let cancelled = false;
    const localBrowserSessionId = getBrowserSessionId();
    const controllers = new Map<string, AbortController>();
    // Tracks which messageIds have had onStreamComplete called to prevent
    // double-firing when both the SSE done sentinel and chat:stream_complete
    // arrive, and to gate post-error stream_complete events.
    const processed = new Set<string>();
    // Bootstrap-discovered own-stream messageIds. Acts as both an "is-own"
    // lookup and a one-shot guard for onOwnStreamFinalize.
    const ownStreamIds = new Set<string>();

    const { addStream, appendPart, removeStream, clearPageStreams } =
      usePendingStreamsStore.getState();

    const fireComplete = (messageId: string, conversationId?: string) => {
      if (processed.has(messageId)) return;
      processed.add(messageId);
      onStreamCompleteRef.current?.(messageId, conversationId);
    };

    const fireOwnFinalize = (messageId: string) => {
      if (!ownStreamIds.has(messageId)) return;
      ownStreamIds.delete(messageId);
      onOwnStreamFinalizeRef.current?.({ messageId });
    };

    const startConsume = (messageId: string, conversationId?: string, skipReplayCount = 0) => {
      if (!claimBootstrapConsumer(messageId)) return;
      const controller = new AbortController();
      controllers.set(messageId, controller);

      // The multicast registry replays its FULL buffer to every new subscriber
      // (see stream-multicast-registry.subscribe). When we've already seeded the
      // store with a persisted-parts snapshot, that snapshot is a prefix of the
      // live buffer, so the first `skipReplayCount` replayed chunks are the same
      // ones we already applied — skip them to avoid duplicating content.
      let chunksToSkip = skipReplayCount;

      consumeStreamJoin(messageId, controller.signal, (part) => {
        if (chunksToSkip > 0) {
          chunksToSkip -= 1;
          return;
        }
        appendPart(messageId, part);
      })
        .then(() => {
          // Cleanup runs synchronously on unmount but the SSE promise resolves
          // asynchronously after controller.abort(); skip post-teardown effects.
          if (cancelled) return;
          controllers.delete(messageId);
          releaseBootstrapConsumer(messageId);
          try {
            fireComplete(messageId, conversationId);
          } finally {
            removeStream(messageId);
            fireOwnFinalize(messageId);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          controllers.delete(messageId);
          releaseBootstrapConsumer(messageId);
          // Mark as processed so a subsequent chat:stream_complete event for
          // the same messageId is a no-op for onStreamComplete: the catch
          // path already finalized this stream locally.
          processed.add(messageId);
          // When the store was seeded from a persisted snapshot
          // (skipReplayCount > 0), a failed join usually means the
          // originator's process died — its in-memory registry is gone and
          // the join 404s. That snapshot is the only surviving copy of the
          // partial content, so keep it rendered; removing it here would
          // undo the restore that just happened. Streams with no seeded
          // snapshot have nothing to preserve and are removed as before.
          if (skipReplayCount === 0) {
            removeStream(messageId);
          }
          fireOwnFinalize(messageId);
          if (!controller.signal.aborted) {
            console.error('[useChannelStreamSocket] SSE join error:', err);
          }
        });
    };

    // Bootstrap: replay in-flight streams from the DB so a refresh mid-stream
    // (or a mobile resume) doesn't lose visibility on what's currently happening
    // in this channel. Re-running is idempotent: claimBootstrapConsumer +
    // shouldSkipBootstrappedStream skip streams already being consumed.
    const runBootstrap = async () => {
      try {
        const res = await fetchWithAuth(
          `/api/ai/chat/active-streams?channelId=${encodeURIComponent(channelId)}`,
          { credentials: 'include' },
        );
        if (cancelled) return;
        if (!res.ok) return;
        const data = (await res.json()) as { streams?: ActiveStreamRow[] };
        if (cancelled) return;
        for (const stream of data.streams ?? []) {
          if (shouldSkipBootstrappedStream(stream.messageId, processed, controllers)) continue;
          const isOwn = isOwnStream(stream.triggeredBy, localBrowserSessionId);
          // Seed the persisted snapshot as the stream's initial parts so the
          // restored mid-stream content renders immediately — without waiting
          // on (or depending on) the live multicast, which is unavailable if
          // the originator's process has died. Seeding through addStream
          // (a no-op when the entry exists) keeps a co-mounted surface that
          // bootstrapped the same channel from appending the snapshot twice.
          // The persisted snapshot is the raw registry buffer (one entry per
          // pushed chunk: every text delta, and a separate frame per tool-call
          // state transition) — the same shape the live SSE replay delivers.
          // isValidPartFrame applies the same wire-trust gate the live path
          // applies in consumeStreamJoin, and the count of frames that pass
          // it is what the replay will actually skip past (see
          // skipReplayCount below); appendPartPure then folds the raw
          // sequence the way the store's own appendPart does for every live
          // chunk, so a restored snapshot renders identically to a live one
          // (merged text, tool parts converged to their latest state).
          const persistedParts = (stream.parts ?? []).filter(isValidPartFrame);
          const foldedParts = persistedParts.reduce(appendPartPure, [] as UIMessagePart[]);
          addStream({
            messageId: stream.messageId,
            pageId: channelId,
            conversationId: stream.conversationId,
            triggeredBy: stream.triggeredBy,
            isOwn,
            parts: foldedParts,
            startedAt: stream.startedAt,
          });
          if (isOwn) {
            ownStreamIds.add(stream.messageId);
            onOwnStreamBootstrapRef.current?.({ messageId: stream.messageId });
          }
          startConsume(stream.messageId, stream.conversationId, persistedParts.length);
        }
      } catch (err) {
        if (cancelled) return;
        console.warn('[useChannelStreamSocket] bootstrap failed', err);
      }
    };

    // Expose runBootstrap so rejoinActiveStreams (returned from the hook) can
    // trigger it on mobile resume — always points at the live closure.
    bootstrapRef.current = runBootstrap;

    void runBootstrap();

    const handleStreamStart = (payload: AiStreamStartPayload) => {
      if (payload.pageId !== channelId) return;
      if (isOwnStream(payload.triggeredBy, localBrowserSessionId)) return;
      if (controllers.has(payload.messageId)) return;

      addStream({
        messageId: payload.messageId,
        pageId: payload.pageId,
        conversationId: payload.conversationId,
        triggeredBy: payload.triggeredBy,
        isOwn: false,
        startedAt: payload.startedAt,
      });

      startConsume(payload.messageId, payload.conversationId);
    };

    const handleStreamComplete = (payload: AiStreamCompletePayload) => {
      if (payload.pageId !== channelId) return;
      const controller = controllers.get(payload.messageId);
      if (controller) {
        controller.abort();
        controllers.delete(payload.messageId);
      }
      try {
        fireComplete(payload.messageId, payload.conversationId);
      } finally {
        removeStream(payload.messageId);
        fireOwnFinalize(payload.messageId);
      }
    };

    const handleUserMessage = (payload: ChatUserMessagePayload) => {
      if (payload.pageId !== channelId) return;
      if (isOwnStream(payload.triggeredBy, localBrowserSessionId)) return;
      onUserMessageRef.current?.(payload.message, payload);
    };

    const handleMessageEdited = (payload: ChatMessageEditedPayload) => {
      if (payload.pageId !== channelId) return;
      if (isOwnStream(payload.triggeredBy, localBrowserSessionId)) return;
      onMessageEditedRef.current?.(payload);
    };

    const handleMessageDeleted = (payload: ChatMessageDeletedPayload) => {
      if (payload.pageId !== channelId) return;
      if (isOwnStream(payload.triggeredBy, localBrowserSessionId)) return;
      onMessageDeletedRef.current?.(payload);
    };

    const handleUndoApplied = (payload: ChatUndoAppliedPayload) => {
      if (payload.pageId !== channelId) return;
      if (isOwnStream(payload.triggeredBy, localBrowserSessionId)) return;
      onUndoAppliedRef.current?.(payload);
    };

    const handleConversationAdded = (payload: ChatConversationAddedPayload) => {
      if (payload.agentId !== channelId) return;
      if (isOwnStream(payload.triggeredBy, localBrowserSessionId)) return;
      onConversationAddedRef.current?.(payload);
    };

    const handleConversationRenamed = (payload: ChatConversationRenamedPayload) => {
      if (payload.agentId !== channelId) return;
      if (isOwnStream(payload.triggeredBy, localBrowserSessionId)) return;
      onConversationRenamedRef.current?.(payload);
    };

    const handleConversationDeleted = (payload: ChatConversationDeletedPayload) => {
      if (payload.agentId !== channelId) return;
      if (isOwnStream(payload.triggeredBy, localBrowserSessionId)) return;
      onConversationDeletedRef.current?.(payload);
    };

    const handleGlobalConversationAdded = (payload: ChatGlobalConversationAddedPayload) => {
      // No own-session filter: the history tab must update even when the conversation
      // was created in the current tab (it has no other signal).
      onGlobalConversationAddedRef.current?.(payload);
    };

    // The realtime server emits this on permission revocation (see kick-handler.ts) using
    // the page/channel room id directly (socket.join(pageId)), so `room` is the channelId.
    const handleAccessRevoked = (payload: AccessRevokedPayload) => {
      if (payload.room !== channelId) return;
      // Set cancelled first, exactly like unmount: consumeStreamJoin resolves (not
      // rejects) on abort, so without this the pending .then()/.catch() would run
      // the "clean finalize" path (onStreamComplete, onOwnStreamFinalize) for a
      // stream that was actually killed by a permission revocation, not completion.
      cancelled = true;
      for (const [msgId, controller] of controllers.entries()) {
        controller.abort();
        releaseBootstrapConsumer(msgId);
      }
      clearPageStreams(channelId);
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
      for (const [msgId, controller] of controllers.entries()) {
        controller.abort();
        releaseBootstrapConsumer(msgId);
      }
      clearPageStreams(channelId);
    };
  }, [socket, channelId]);

  // Stable callback; the ref always points at the latest runBootstrap closure.
  const rejoinActiveStreams = useCallback(() => { bootstrapRef.current?.(); }, []);

  return { rejoinActiveStreams };
}
