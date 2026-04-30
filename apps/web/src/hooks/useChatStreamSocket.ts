import { useEffect, useRef } from 'react';
import { useSocket } from './useSocket';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { consumeStreamJoin } from '@/lib/ai/core/stream-join-client';
import { getTabId } from '@/lib/ai/core/tab-id';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { AiStreamStartPayload, AiStreamCompletePayload } from '@/lib/websocket/socket-utils';

interface ActiveStreamRow {
  messageId: string;
  conversationId: string;
  triggeredBy: { userId: string; displayName: string; tabId: string };
}

export function useChatStreamSocket(
  channelId: string | undefined,
  currentUserId: string | undefined,
  onStreamComplete?: (messageId: string) => void,
): void {
  const socket = useSocket();
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  // Tracks which messageIds have had onStreamComplete called to prevent double-firing
  // when both the SSE done sentinel and the chat:stream_complete socket event arrive.
  const processedRef = useRef<Set<string>>(new Set());
  // Stable ref so onStreamComplete changes never cause handler re-registration.
  const onStreamCompleteRef = useRef(onStreamComplete);
  onStreamCompleteRef.current = onStreamComplete;

  // currentUserId is currently unused (filter switched to tabId), retained
  // in the signature so callers don't need to change at the page-level boundary.
  void currentUserId;

  useEffect(() => {
    if (!socket || !channelId) return;

    let cancelled = false;
    const localTabId = getTabId();

    const { addStream, appendText, removeStream, clearPageStreams } =
      usePendingStreamsStore.getState();

    const fireComplete = (messageId: string) => {
      if (processedRef.current.has(messageId)) return;
      processedRef.current.add(messageId);
      onStreamCompleteRef.current?.(messageId);
    };

    const startConsume = (messageId: string) => {
      const controller = new AbortController();
      controllersRef.current.set(messageId, controller);

      consumeStreamJoin(messageId, controller.signal, (chunk) => {
        appendText(messageId, chunk);
      })
        .then(() => {
          controllersRef.current.delete(messageId);
          try {
            fireComplete(messageId);
          } finally {
            removeStream(messageId);
          }
        })
        .catch((err) => {
          controllersRef.current.delete(messageId);
          removeStream(messageId);
          if (!controller.signal.aborted) {
            console.error('[useChatStreamSocket] SSE join error:', err);
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
          addStream({
            messageId: stream.messageId,
            pageId: channelId,
            conversationId: stream.conversationId,
            triggeredBy: stream.triggeredBy,
            isOwn: stream.triggeredBy.tabId === localTabId,
          });
          startConsume(stream.messageId);
        }
      } catch (err) {
        if (cancelled) return;
        console.warn('[useChatStreamSocket] bootstrap failed', err);
      }
    })();

    const handleStreamStart = (payload: AiStreamStartPayload) => {
      if (payload.pageId !== channelId) return;
      if (payload.triggeredBy.tabId === localTabId) return;
      if (controllersRef.current.has(payload.messageId)) return;

      addStream({
        messageId: payload.messageId,
        pageId: payload.pageId,
        conversationId: payload.conversationId,
        triggeredBy: payload.triggeredBy,
        isOwn: payload.triggeredBy.tabId === localTabId,
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
      clearPageStreams(channelId);
    };
  }, [socket, channelId]);
}
