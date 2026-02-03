'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useSWRConfig } from 'swr';
import { useSocket } from './useSocket';
import { isEditingActive } from '@/stores/useEditingStore';
import type { InboxEventPayload } from '@/lib/websocket/socket-utils';
import type { InboxResponse } from '@pagespace/lib';

interface UseInboxSocketOptions {
  driveId?: string;
}

/**
 * Hook that listens for inbox events (DM/channel updates) and updates the SWR cache.
 * Integrates with editing store to prevent updates during active editing sessions.
 */
export function useInboxSocket({ driveId }: UseInboxSocketOptions = {}) {
  const socket = useSocket();
  const { mutate } = useSWRConfig();
  const hasLoadedRef = useRef(false);

  // Build the SWR cache key
  const getCacheKey = useCallback(() => {
    return driveId
      ? `/api/inbox?driveId=${driveId}&limit=20`
      : '/api/inbox?limit=20';
  }, [driveId]);

  useEffect(() => {
    if (!socket) return;

    const handleInboxUpdate = (payload: InboxEventPayload) => {
      // Skip updates if we haven't loaded yet or if editing is active
      if (!hasLoadedRef.current || isEditingActive()) {
        return;
      }

      const cacheKey = getCacheKey();

      // Optimistically update the SWR cache
      mutate(
        cacheKey,
        (currentData: InboxResponse | undefined) => {
          if (!currentData) return currentData;

          const updatedItems = [...currentData.items];
          const existingIndex = updatedItems.findIndex(
            item => item.id === payload.id && item.type === payload.type
          );

          if (existingIndex >= 0) {
            // Update existing item
            const existingItem = updatedItems[existingIndex];
            updatedItems[existingIndex] = {
              ...existingItem,
              lastMessageAt: payload.lastMessageAt || existingItem.lastMessageAt,
              lastMessagePreview: payload.lastMessagePreview || existingItem.lastMessagePreview,
              lastMessageSender: payload.lastMessageSender || existingItem.lastMessageSender,
              unreadCount: payload.unreadCount !== undefined
                ? payload.unreadCount
                : (payload.operation === 'read_status_changed' ? 0 : (existingItem.unreadCount + 1)),
            };
          } else {
            // New conversation not in cache - trigger revalidation to fetch full data
            mutate(cacheKey);
            return currentData;
          }

          // Re-sort by lastMessageAt (most recent first)
          updatedItems.sort((a, b) => {
            if (!a.lastMessageAt && !b.lastMessageAt) return 0;
            if (!a.lastMessageAt) return 1;
            if (!b.lastMessageAt) return -1;
            return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
          });

          return {
            ...currentData,
            items: updatedItems,
          };
        },
        { revalidate: false }
      );
    };

    // Listen for all inbox event types
    socket.on('inbox:dm_updated', handleInboxUpdate);
    socket.on('inbox:channel_updated', handleInboxUpdate);
    socket.on('inbox:read_status_changed', handleInboxUpdate);

    return () => {
      socket.off('inbox:dm_updated', handleInboxUpdate);
      socket.off('inbox:channel_updated', handleInboxUpdate);
      socket.off('inbox:read_status_changed', handleInboxUpdate);
    };
  }, [socket, getCacheKey, mutate]);

  return {
    hasLoadedRef,
    isSocketConnected: !!socket?.connected,
  };
}
