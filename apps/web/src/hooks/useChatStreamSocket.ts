import { useEffect, useRef } from 'react';
import { useSocket } from './useSocket';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { consumeStreamJoin } from '@/lib/ai/core/stream-join-client';
import type { AiStreamStartPayload, AiStreamCompletePayload } from '@/lib/websocket/socket-utils';

export function useChatStreamSocket(
  pageId: string | undefined,
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

  useEffect(() => {
    if (!socket || !pageId) return;

    const { addStream, appendText, removeStream, clearPageStreams } =
      usePendingStreamsStore.getState();

    const fireComplete = (messageId: string) => {
      if (processedRef.current.has(messageId)) return;
      processedRef.current.add(messageId);
      onStreamCompleteRef.current?.(messageId);
    };

    const handleStreamStart = (payload: AiStreamStartPayload) => {
      // A1: ignore events for other pages (stale-room guard)
      if (payload.pageId !== pageId) return;
      if (payload.triggeredBy.userId === currentUserId) return;

      addStream({
        messageId: payload.messageId,
        pageId: payload.pageId,
        conversationId: payload.conversationId,
        triggeredBy: payload.triggeredBy,
      });

      const controller = new AbortController();
      controllersRef.current.set(payload.messageId, controller);

      consumeStreamJoin(payload.messageId, controller.signal, (chunk) => {
        appendText(payload.messageId, chunk);
      })
        .then(() => {
          controllersRef.current.delete(payload.messageId);
          removeStream(payload.messageId);
          fireComplete(payload.messageId);
        })
        .catch((err) => {
          controllersRef.current.delete(payload.messageId);
          removeStream(payload.messageId);
          if (!controller.signal.aborted) {
            console.error('[useChatStreamSocket] SSE join error:', err);
          }
        });
    };

    const handleStreamComplete = (payload: AiStreamCompletePayload) => {
      // A1: ignore events for other pages (stale-room guard)
      if (payload.pageId !== pageId) return;
      const controller = controllersRef.current.get(payload.messageId);
      if (controller) {
        controller.abort();
        controllersRef.current.delete(payload.messageId);
      }
      removeStream(payload.messageId);
      fireComplete(payload.messageId);
    };

    socket.on('chat:stream_start', handleStreamStart);
    socket.on('chat:stream_complete', handleStreamComplete);

    return () => {
      socket.off('chat:stream_start', handleStreamStart);
      socket.off('chat:stream_complete', handleStreamComplete);
      for (const controller of controllersRef.current.values()) {
        controller.abort();
      }
      controllersRef.current.clear();
      processedRef.current.clear();
      clearPageStreams(pageId);
    };
  }, [socket, pageId, currentUserId]); // A3: onStreamComplete intentionally excluded — use ref
}
