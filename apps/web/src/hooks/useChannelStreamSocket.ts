import { useEffect, useRef } from 'react';
import { useSocket } from './useSocket';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { consumeStreamJoin } from '@/lib/ai/core/stream-join-client';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { AiStreamStartPayload, AiStreamCompletePayload } from '@/lib/websocket/socket-utils';

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
  onStreamCompleteRef.current = options?.onStreamComplete;
  onOwnStreamBootstrapRef.current = options?.onOwnStreamBootstrap;
  onOwnStreamFinalizeRef.current = options?.onOwnStreamFinalize;

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

    const { addStream, appendText, removeStream, clearPageStreams } =
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

      consumeStreamJoin(messageId, controller.signal, (chunk) => {
        appendText(messageId, chunk);
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
          if (processed.has(stream.messageId)) continue;
          if (controllers.has(stream.messageId)) continue;
          const isOwn = stream.triggeredBy.browserSessionId === localBrowserSessionId;
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
      if (payload.triggeredBy.browserSessionId === localBrowserSessionId) return;
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

    socket.on('chat:stream_start', handleStreamStart);
    socket.on('chat:stream_complete', handleStreamComplete);

    return () => {
      cancelled = true;
      socket.off('chat:stream_start', handleStreamStart);
      socket.off('chat:stream_complete', handleStreamComplete);
      for (const controller of controllers.values()) {
        controller.abort();
      }
      clearPageStreams(channelId);
    };
  }, [socket, channelId]);
}
