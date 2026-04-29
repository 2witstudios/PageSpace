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

  useEffect(() => {
    if (!socket || !pageId) return;

    const { addStream, appendText, removeStream, clearPageStreams } =
      usePendingStreamsStore.getState();

    const handleStreamStart = (payload: AiStreamStartPayload) => {
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
          onStreamComplete?.(payload.messageId);
        })
        .catch(() => {
          controllersRef.current.delete(payload.messageId);
        });
    };

    const handleStreamComplete = (payload: AiStreamCompletePayload) => {
      const controller = controllersRef.current.get(payload.messageId);
      if (controller) {
        controller.abort();
        controllersRef.current.delete(payload.messageId);
      }
      removeStream(payload.messageId);
      onStreamComplete?.(payload.messageId);
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
      clearPageStreams(pageId);
    };
  }, [socket, pageId, currentUserId, onStreamComplete]);
}
