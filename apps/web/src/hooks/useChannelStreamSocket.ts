import { useEffect, useRef } from 'react';
import { useSocket } from './useSocket';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { consumeStreamJoin } from '@/lib/ai/core/stream-join-client';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { isOwnStream } from '@/lib/ai/streams/isOwnStream';
import { shouldSkipBootstrappedStream } from '@/lib/ai/streams/shouldSkipBootstrappedStream';
import type {
  AiStreamStartPayload,
  AiStreamCompletePayload,
  ChatUserMessagePayload,
  ChatMessageEditedPayload,
  ChatMessageDeletedPayload,
  ChatUndoAppliedPayload,
} from '@/lib/websocket/socket-utils';
import type { UIMessage } from 'ai';

interface ActiveStreamRow {
  messageId: string;
  conversationId: string;
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}

export interface UseChannelStreamSocketOptions {
  /** Fires once per messageId on clean finalize (SSE resolve or socket complete); NOT on SSE error. */
  onStreamComplete?: (messageId: string) => void;
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
}

/** Subscribes a component to a channel's AI streaming lifecycle: DB-replay on mount, live socket events, SSE join, store cleanup on unmount. Pass `undefined` channelId to no-op. */
export function useChannelStreamSocket(
  channelId: string | undefined,
  options?: UseChannelStreamSocketOptions,
): void {
  const socket = useSocket();
  // Stable refs so callback identity changes never trigger handler re-registration.
  const onStreamCompleteRef = useRef(options?.onStreamComplete);
  const onOwnStreamBootstrapRef = useRef(options?.onOwnStreamBootstrap);
  const onOwnStreamFinalizeRef = useRef(options?.onOwnStreamFinalize);
  const onUserMessageRef = useRef(options?.onUserMessage);
  const onMessageEditedRef = useRef(options?.onMessageEdited);
  const onMessageDeletedRef = useRef(options?.onMessageDeleted);
  const onUndoAppliedRef = useRef(options?.onUndoApplied);
  onStreamCompleteRef.current = options?.onStreamComplete;
  onOwnStreamBootstrapRef.current = options?.onOwnStreamBootstrap;
  onOwnStreamFinalizeRef.current = options?.onOwnStreamFinalize;
  onUserMessageRef.current = options?.onUserMessage;
  onMessageEditedRef.current = options?.onMessageEdited;
  onMessageDeletedRef.current = options?.onMessageDeleted;
  onUndoAppliedRef.current = options?.onUndoApplied;

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

    const fireComplete = (messageId: string) => {
      if (processed.has(messageId)) return;
      processed.add(messageId);
      onStreamCompleteRef.current?.(messageId);
    };

    const fireOwnFinalize = (messageId: string) => {
      if (!ownStreamIds.has(messageId)) return;
      ownStreamIds.delete(messageId);
      onOwnStreamFinalizeRef.current?.({ messageId });
    };

    const startConsume = (messageId: string) => {
      const controller = new AbortController();
      controllers.set(messageId, controller);

      consumeStreamJoin(messageId, controller.signal, (part) => {
        appendPart(messageId, part);
      })
        .then(() => {
          // Cleanup runs synchronously on unmount but the SSE promise resolves
          // asynchronously after controller.abort(); skip post-teardown effects.
          if (cancelled) return;
          controllers.delete(messageId);
          try {
            fireComplete(messageId);
          } finally {
            removeStream(messageId);
            fireOwnFinalize(messageId);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          controllers.delete(messageId);
          // Mark as processed so a subsequent chat:stream_complete event for
          // the same messageId is a no-op for onStreamComplete: the catch
          // path already finalized this stream locally.
          processed.add(messageId);
          removeStream(messageId);
          fireOwnFinalize(messageId);
          if (!controller.signal.aborted) {
            console.error('[useChannelStreamSocket] SSE join error:', err);
          }
        });
    };

    // Bootstrap: replay in-flight streams from the DB so a refresh mid-stream
    // doesn't lose visibility on what's currently happening in this channel.
    (async () => {
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
          addStream({
            messageId: stream.messageId,
            pageId: channelId,
            conversationId: stream.conversationId,
            triggeredBy: stream.triggeredBy,
            isOwn,
          });
          if (isOwn) {
            ownStreamIds.add(stream.messageId);
            onOwnStreamBootstrapRef.current?.({ messageId: stream.messageId });
          }
          startConsume(stream.messageId);
        }
      } catch (err) {
        if (cancelled) return;
        console.warn('[useChannelStreamSocket] bootstrap failed', err);
      }
    })();

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
      });

      startConsume(payload.messageId);
    };

    const handleStreamComplete = (payload: AiStreamCompletePayload) => {
      if (payload.pageId !== channelId) return;
      const controller = controllers.get(payload.messageId);
      if (controller) {
        controller.abort();
        controllers.delete(payload.messageId);
      }
      try {
        fireComplete(payload.messageId);
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

    socket.on('chat:stream_start', handleStreamStart);
    socket.on('chat:stream_complete', handleStreamComplete);
    socket.on('chat:user_message', handleUserMessage);
    socket.on('chat:message_edited', handleMessageEdited);
    socket.on('chat:message_deleted', handleMessageDeleted);
    socket.on('chat:undo_applied', handleUndoApplied);

    return () => {
      cancelled = true;
      socket.off('chat:stream_start', handleStreamStart);
      socket.off('chat:stream_complete', handleStreamComplete);
      socket.off('chat:user_message', handleUserMessage);
      socket.off('chat:message_edited', handleMessageEdited);
      socket.off('chat:message_deleted', handleMessageDeleted);
      socket.off('chat:undo_applied', handleUndoApplied);
      for (const controller of controllers.values()) {
        controller.abort();
      }
      clearPageStreams(channelId);
    };
  }, [socket, channelId]);
}
