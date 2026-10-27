'use client';

import { useEffect, useCallback } from 'react';
import { useSWRConfig } from 'swr';
import { isConnectionRequest } from '@pagespace/lib/notifications/guards';
import { patch } from '@/retained/lib/auth/auth-fetch';
import { useNotificationStore } from '@/retained/stores/useNotificationStore';
import { useSocketStore } from '@/retained/stores/useSocketStore';
import type { StoredNotification } from '@/retained/lib/notifications/notification-groups';

/** Every key the spine's SWR count and this feed read: revalidated after any change here. */
const isNotificationKey = (key: unknown): boolean => typeof key === 'string' && key.startsWith('/api/notifications');

/**
 * The vendored notification store, bound to one mounted surface (the bell's popover or the
 * page). It fetches on mount, listens to the socket while connected and releases the listeners
 * on unmount. Every change also revalidates the spine's unread count, so the bell's badge follows.
 */
export function useNotificationFeed() {
  const { mutate } = useSWRConfig();
  const notifications = useNotificationStore((state) => state.notifications);
  const isLoading = useNotificationStore((state) => state.isLoading);
  const fetchNotifications = useNotificationStore((state) => state.fetchNotifications);
  const handleNotificationRead = useNotificationStore((state) => state.handleNotificationRead);
  const handleMarkAllAsRead = useNotificationStore((state) => state.handleMarkAllAsRead);
  const handleDeleteNotification = useNotificationStore((state) => state.handleDeleteNotification);
  const updateNotification = useNotificationStore((state) => state.updateNotification);
  const initializeSocketListeners = useNotificationStore((state) => state.initializeSocketListeners);
  const cleanupSocketListeners = useNotificationStore((state) => state.cleanupSocketListeners);
  const connectionStatus = useSocketStore((state) => state.connectionStatus);

  const revalidateCount = useCallback(() => {
    void mutate(isNotificationKey);
  }, [mutate]);

  useEffect(() => {
    void fetchNotifications();
    if (connectionStatus === 'connected') initializeSocketListeners();
    return () => {
      cleanupSocketListeners();
    };
  }, [connectionStatus, fetchNotifications, initializeSocketListeners, cleanupSocketListeners]);

  const markRead = async (id: string) => {
    await handleNotificationRead(id);
    revalidateCount();
  };

  const markAll = async () => {
    await handleMarkAllAsRead();
    revalidateCount();
  };

  const dismiss = async (id: string) => {
    await handleDeleteNotification(id);
    revalidateCount();
  };

  /** Accept or decline a connection request; the row then reads Accepted or Declined. */
  const respond = async (notification: StoredNotification, action: 'accept' | 'reject') => {
    if (!isConnectionRequest(notification)) return;
    try {
      await patch(`/api/connections/${notification.metadata.connectionId}`, { action });
      updateNotification(notification.id, {
        isRead: true,
        metadata: {
          ...notification.metadata,
          actioned: true,
          actionedStatus: action === 'accept' ? 'accepted' : 'rejected',
        },
      });
      revalidateCount();
    } catch (error) {
      console.error(`Error ${action === 'accept' ? 'accepting' : 'declining'} connection:`, error);
    }
  };

  const refresh = async () => {
    await fetchNotifications();
    revalidateCount();
  };

  return {
    notifications,
    isLoading,
    markRead,
    markAll,
    dismiss,
    respond,
    refresh,
  };
}
