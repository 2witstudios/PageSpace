'use client';

import { useEffect, useRef } from 'react';
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
  // The pending timer is a ref, not effect-local, and the effect's cleanup
  // deliberately does not clear it. `socket` identity is replaced on every auth
  // refresh (useSocket mints a new Socket rather than mutating the old one), so
  // an effect-local timer meant an event landing in the 250ms either side of a
  // token refresh had its revalidation cancelled by the re-subscribe and never
  // fired — leaving the badge stale until the next event. Only unmount cancels.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    if (!socket) return;
    const revalidate = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void mutate();
      }, REVALIDATE_DEBOUNCE_MS);
    };
    for (const event of SOCKET_EVENTS) socket.on(event, revalidate);
    return () => {
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
