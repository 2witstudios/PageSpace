'use client';

import { useEffect, useRef } from 'react';
import { useSWRConfig } from 'swr';
import { useSocket } from './useSocket';
import { useEditingStore } from '@/stores/useEditingStore';
import { useThreadInboxStore } from '@/stores/useThreadInboxStore';
import type { InboxEventPayload } from '@/lib/websocket/socket-utils';
import type { InboxResponse } from '@pagespace/lib/types';

interface UseInboxSocketOptions {
  /** The exact string passed to useSWR. Must be identical — SWR keys by value. */
  cacheKey: string;
  /** Item types this cache holds. Payloads of other types are ignored. */
  scope: 'dm' | 'channel' | 'all';
  /**
   * Set when this subscription's cache is scoped to one drive (e.g. a
   * drive's channel list). Payloads for other drives are ignored — without
   * this, a channel event from an unrelated drive still passes the `scope`
   * check, fails to match any item in this drive-scoped cache, and falls
   * through to a full-revalidation refetch for every other active drive.
   * Omit for cross-drive views (e.g. "all channels").
   */
  driveId?: string;
  hasLoadedRef?: React.RefObject<boolean>;
}

/**
 * Hook that listens for inbox events (DM/channel updates) and updates the SWR cache.
 * Integrates with editing store to defer (not drop) updates during active editing sessions.
 *
 * @param cacheKey - The exact string the consumer passes to useSWR. SWR keys by value, so
 *                   this must match verbatim or writes land in a cache entry with no subscriber.
 * @param scope - Restricts which payload types this subscription writes to its cache.
 * @param driveId - Restricts to payloads for one drive, for drive-scoped caches.
 * @param hasLoadedRef - Optional ref to track if initial data has loaded. When provided,
 *                       socket updates will only be processed after hasLoadedRef.current is true.
 *                       This prevents socket events from racing with initial data fetches.
 */
export function useInboxSocket({ cacheKey, scope, driveId, hasLoadedRef: externalRef }: UseInboxSocketOptions) {
  const socket = useSocket();
  const { mutate } = useSWRConfig();
  const internalRef = useRef(false);
  const hasLoadedRef = externalRef ?? internalRef;
  const staleRef = useRef(false);

  useEffect(() => {
    if (!socket) return;

    const handleInboxUpdate = (payload: InboxEventPayload) => {
      // Ignore payloads outside this subscription's scope before any other
      // work — otherwise every DM event runs the updater against a channels
      // cache (and vice versa), finds no match, and falls through to a full
      // revalidation fallback per mounted list.
      if (scope !== 'all' && payload.type !== scope) return;

      // Same reasoning for drive scope: a channel event from another drive
      // will never match an item in this drive-scoped cache.
      if (driveId && payload.driveId !== driveId) return;

      // Skip updates if we haven't loaded yet (race guard against the initial fetch).
      if (!hasLoadedRef.current) return;

      if (useEditingStore.getState().isAnyEditing()) {
        // Defer, don't drop: the editing-store subscription effect below
        // replays this once editing ends.
        staleRef.current = true;
        return;
      }

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

            // A sidebar and its matching center list (e.g. DMSidebar +
            // DMCenterList on /dashboard/dms) share this exact cacheKey and
            // each mount their own useInboxSocket, so both run this updater
            // independently for the same socket event. mutate()'s functional
            // updater applies synchronously, so the second call's
            // currentData already reflects the first call's write — visible
            // here as lastMessageAt already matching the incoming payload.
            // Without this guard, one message double-increments unreadCount
            // (0 -> 1 -> 2). payload.unreadCount (an explicit value from the
            // server) and read_status_changed's reset to 0 are naturally
            // idempotent already, so only the +1 fallback needs guarding.
            const willIncrement = payload.unreadCount === undefined && payload.operation !== 'read_status_changed';
            if (willIncrement && payload.lastMessageAt !== undefined && payload.lastMessageAt === existingItem.lastMessageAt) {
              return currentData;
            }

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

    // PR 5: thread_updated bumps a per-row "unread thread" badge in
    // useThreadInboxStore WITHOUT touching the SWR cache or top-level unread
    // count. The handler is intentionally separate so we can keep the existing
    // dm/channel/read handler unchanged.
    const handleThreadUpdated = (payload: InboxEventPayload) => {
      if (payload.operation !== 'thread_updated' || !payload.rootMessageId) return;
      if (!hasLoadedRef.current) return;
      useThreadInboxStore.getState().bump({
        source: payload.type,
        contextId: payload.id,
        rootMessageId: payload.rootMessageId,
      });
    };

    // Listen for all inbox event types
    socket.on('inbox:dm_updated', handleInboxUpdate);
    socket.on('inbox:channel_updated', handleInboxUpdate);
    socket.on('inbox:read_status_changed', handleInboxUpdate);
    socket.on('inbox:thread_updated', handleThreadUpdated);

    return () => {
      socket.off('inbox:dm_updated', handleInboxUpdate);
      socket.off('inbox:channel_updated', handleInboxUpdate);
      socket.off('inbox:read_status_changed', handleInboxUpdate);
      socket.off('inbox:thread_updated', handleThreadUpdated);
    };
  }, [socket, cacheKey, scope, driveId, mutate, hasLoadedRef]);

  // Replay path: an update dropped while editing was active is never lost —
  // once every editing session ends, revalidate the cache from the server.
  useEffect(() => {
    const unsubscribe = useEditingStore.subscribe((state) => {
      if (staleRef.current && !state.isAnyEditing()) {
        staleRef.current = false;
        mutate(cacheKey);
      }
    });
    return unsubscribe;
  }, [cacheKey, mutate]);

  return {
    hasLoadedRef,
    isSocketConnected: !!socket?.connected,
  };
}
