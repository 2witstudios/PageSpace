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
  onStreamComplete?: (messageId: string) => void;
  onOwnStreamBootstrap?: (event: { messageId: string }) => void;
  onOwnStreamFinalize?: (event: { messageId: string }) => void;
}

export function useChannelStreamSocket(
  channelId: string | undefined,
  options?: UseChannelStreamSocketOptions,
): void {
  const socket = useSocket();
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  // Tracks which messageIds have had onStreamComplete called to prevent double-firing
  // when both the SSE done sentinel and the chat:stream_complete socket event arrive.
  const processedRef = useRef<Set<string>>(new Set());
  // Bootstrap-discovered own-stream messageIds. Acts as both an "is-own" lookup
  // and a one-shot guard for onOwnStreamFinalize.
  const ownStreamIdsRef = useRef<Set<string>>(new Set());
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

    const { addStream, appendText, removeStream, clearPageStreams } =
      usePendingStreamsStore.getState();

    const fireComplete = (messageId: string) => {
      if (processedRef.current.has(messageId)) return;
      processedRef.current.add(messageId);
      onStreamCompleteRef.current?.(messageId);
    };

    const fireOwnFinalize = (messageId: string) => {
      if (!ownStreamIdsRef.current.has(messageId)) return;
      ownStreamIdsRef.current.delete(messageId);
      onOwnStreamFinalizeRef.current?.({ messageId });
    };

    const startConsume = (messageId: string) => {
      const controller = new AbortController();
      controllersRef.current.set(messageId, controller);

      consumeStreamJoin(messageId, controller.signal, (chunk) => {
        appendText(messageId, chunk);
      })
        .then(() => {
          // Cleanup runs synchronously on unmount but the SSE promise resolves
          // asynchronously after controller.abort(); skip post-teardown effects.
          if (cancelled) return;
          controllersRef.current.delete(messageId);
          try {
            fireComplete(messageId);
          } finally {
            removeStream(messageId);
            fireOwnFinalize(messageId);
          }
        })
        .catch((err) => {
          controllersRef.current.delete(messageId);
          if (cancelled) return;
          // Mark as processed so a subsequent chat:stream_complete event for
          // the same messageId is a no-op for onStreamComplete: the catch
          // path already finalized this stream locally.
          processedRef.current.add(messageId);
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
          if (processedRef.current.has(stream.messageId)) continue;
          if (controllersRef.current.has(stream.messageId)) continue;
          const isOwn = stream.triggeredBy.browserSessionId === localBrowserSessionId;
          addStream({
            messageId: stream.messageId,
            pageId: channelId,
            conversationId: stream.conversationId,
            triggeredBy: stream.triggeredBy,
            isOwn,
          });
          if (isOwn) {
            ownStreamIdsRef.current.add(stream.messageId);
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
      if (controllersRef.current.has(payload.messageId)) return;

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
      const controller = controllersRef.current.get(payload.messageId);
      if (controller) {
        controller.abort();
        controllersRef.current.delete(payload.messageId);
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
      for (const controller of controllersRef.current.values()) {
        controller.abort();
      }
      controllersRef.current.clear();
      processedRef.current.clear();
      ownStreamIdsRef.current.clear();
      clearPageStreams(channelId);
    };
  }, [socket, channelId]);
}
