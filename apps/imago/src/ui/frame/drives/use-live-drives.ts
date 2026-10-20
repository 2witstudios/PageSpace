'use client';

import { useEffect } from 'react';
import { useSWRConfig } from 'swr';
import { useSocketStore } from '@/retained/stores/useSocketStore';
import { DRIVES } from './drives';

/** The drive events the realtime server sends to each viewer's own drives room (user:<id>:drives). */
const DRIVE_EVENTS = ['drive:created', 'drive:updated', 'drive:deleted', 'drive:member_added', 'drive:member_removed'] as const;

/** command/workflow changes ride drive:updated too, but leave the drive list as it was. */
const changesDriveList = (payload: unknown): boolean =>
  !(typeof payload === 'object' && payload !== null && 'resourceType' in payload && payload.resourceType !== undefined);

/**
 * Keeps the shell's drive list current: a rename, a new image or color, or a
 * drive gained or lost elsewhere refetches it, so the spine tile and the
 * switcher follow without a reload (as classic's useGlobalDriveSocket does).
 */
export function useLiveDrives(): void {
  const socket = useSocketStore((state) => state.socket);
  const { mutate } = useSWRConfig();
  useEffect(() => {
    if (!socket) return;
    const refresh = (payload: unknown) => {
      if (changesDriveList(payload)) void mutate(DRIVES);
    };
    for (const event of DRIVE_EVENTS) socket.on(event, refresh);
    return () => {
      for (const event of DRIVE_EVENTS) socket.off(event, refresh);
    };
  }, [socket, mutate]);
}
