'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSocket } from './useSocket';
import { useNotificationStore } from '@/stores/useNotificationStore';

export type SidebarBadges = {
  dms: number;
  channels: number;
  files: number;
  tasks: number;
  calendar: number;
};

const fetcher = async (url: string): Promise<SidebarBadges> => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch sidebar badges');
  return res.json() as Promise<SidebarBadges>;
};

const EMPTY: SidebarBadges = { dms: 0, channels: 0, files: 0, tasks: 0, calendar: 0 };

const SOCKET_EVENTS = [
  'notification:new',
  'inbox:dm_updated',
  'inbox:channel_updated',
  'inbox:thread_updated',
  'inbox:read_status_changed',
] as const;

const REVALIDATE_DEBOUNCE_MS = 250;

export function useSidebarBadges(): SidebarBadges {
  const socket = useSocket();
  const { data, mutate } = useSWR<SidebarBadges>('/api/sidebar/badges', fetcher);

  // Revalidate when socket events arrive. `inbox:channel_updated` is the one
  // that fans out to every viewable member on a new channel message — without
  // it the Channels badge only moved on mentions and stayed stale until reload.
  //
  // Debounced because channel traffic is burstier than DM/notification traffic
  // and each event triggers a full /api/sidebar/badges refetch; undebounced, a
  // busy channel fires one request per message.
  useEffect(() => {
    if (!socket) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const revalidate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void mutate();
      }, REVALIDATE_DEBOUNCE_MS);
    };
    for (const event of SOCKET_EVENTS) socket.on(event, revalidate);
    return () => {
      if (timer) clearTimeout(timer);
      for (const event of SOCKET_EVENTS) socket.off(event, revalidate);
    };
  }, [socket, mutate]);

  // Revalidate when the user marks notifications as read in the current tab.
  // handleNotificationRead / handleMarkAllAsRead update Zustand state only —
  // no socket event fires — so we watch unreadCount directly as the trigger.
  const notificationUnreadCount = useNotificationStore((state) => state.unreadCount);
  useEffect(() => {
    void mutate();
  }, [notificationUnreadCount, mutate]);

  return data ?? EMPTY;
}
