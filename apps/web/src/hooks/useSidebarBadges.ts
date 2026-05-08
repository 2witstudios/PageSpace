'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useSocket } from './useSocket';

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

export function useSidebarBadges(): SidebarBadges {
  const socket = useSocket();
  const { data, mutate } = useSWR<SidebarBadges>('/api/sidebar/badges', fetcher);

  useEffect(() => {
    if (!socket) return;
    const revalidate = () => void mutate();
    socket.on('notification:new', revalidate);
    socket.on('inbox:dm_updated', revalidate);
    socket.on('inbox:read_status_changed', revalidate);
    return () => {
      socket.off('notification:new', revalidate);
      socket.off('inbox:dm_updated', revalidate);
      socket.off('inbox:read_status_changed', revalidate);
    };
  }, [socket, mutate]);

  return data ?? EMPTY;
}
