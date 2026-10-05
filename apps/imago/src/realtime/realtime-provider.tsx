'use client';

import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import { getBrowserRealtimeClient, type RealtimeClient } from './realtime-client';

const RealtimeContext = createContext<RealtimeClient | null>(null);

/**
 * Keeps the tab connected to realtime while it is mounted (once, in the root
 * layout, so navigation never reconnects) and gives useSocketEvent its
 * socket. `client` is a seam for tests; the page uses the browser's.
 */
export function RealtimeProvider({
  client,
  children,
}: {
  client?: RealtimeClient;
  children: ReactNode;
}) {
  const realtime = client ?? getBrowserRealtimeClient();

  useEffect(() => {
    realtime.socket();
    return () => realtime.disconnect();
  }, [realtime]);

  return <RealtimeContext.Provider value={realtime}>{children}</RealtimeContext.Provider>;
}

/**
 * Calls `handler` for every `event` from realtime while the component is
 * mounted. Subscribes once per event name, however often the component
 * re-renders (the latest handler is always the one called), and removes its
 * listener on unmount.
 */
export function useSocketEvent<Args extends unknown[] = unknown[]>(
  event: string,
  handler: (...args: Args) => void,
): void {
  const realtime = useContext(RealtimeContext);
  if (!realtime) throw new Error('useSocketEvent must be used inside <RealtimeProvider>');

  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });

  useEffect(() => {
    const socket = realtime.socket();
    // Payloads are whatever realtime sent; the caller's handler declares their shape.
    const listener = (...args: unknown[]) => latest.current(...(args as Args));
    socket.on(event, listener);
    return () => {
      socket.off(event, listener);
    };
  }, [realtime, event]);
}

/**
 * Reads this tab's socket id when called, for a write that should not be
 * echoed back as someone else's change (apps/web's X-Socket-ID); undefined
 * while the socket has none.
 */
export function useSocketId(): () => string | undefined {
  const realtime = useContext(RealtimeContext);
  if (!realtime) throw new Error('useSocketId must be used inside <RealtimeProvider>');
  return useCallback(() => realtime.socket().id, [realtime]);
}

/** realtime's event for joining a drive's room (apps/realtime/src/index.ts). */
export const JOIN_DRIVE = 'join_drive';

/**
 * Keeps this tab in `driveId`'s realtime room while mounted, where page
 * events for the drive are sent: joins once the socket is connected and again
 * after every reconnect, since realtime forgets a socket's rooms when it
 * drops. Realtime checks drive access itself. Like classic, the room is not
 * left on unmount or on a drive switch: other hooks may share it, and handlers
 * filter events by drive.
 */
export function useDriveRoom(driveId: string | null): void {
  const realtime = useContext(RealtimeContext);
  if (!realtime) throw new Error('useDriveRoom must be used inside <RealtimeProvider>');

  useEffect(() => {
    if (driveId === null) return;
    const socket = realtime.socket();
    const join = () => {
      socket.emit(JOIN_DRIVE, driveId);
    };
    if (socket.connected) join();
    socket.on('connect', join);
    return () => {
      socket.off('connect', join);
    };
  }, [realtime, driveId]);
}

/** The pair of realtime events that enter and leave one kind of room. */
export type RoomEvents = { readonly join: string; readonly leave: string };

/** A channel page's room, where its posts are broadcast as `new_message` (apps/realtime/src/index.ts). */
export const CHANNEL_ROOM: RoomEvents = { join: 'join_channel', leave: 'leave_channel' };

/** A DM conversation's room, where its messages are broadcast as `new_dm_message` (apps/realtime/src/index.ts). */
export const DM_ROOM: RoomEvents = { join: 'join_dm_conversation', leave: 'leave_dm_conversation' };

/**
 * Keeps this tab in the realtime room `id` names while mounted: joins once
 * connected and again after every reconnect, since realtime forgets a
 * socket's rooms when it drops, and leaves when the room closes or changes,
 * as classic's channel and DM views do. Realtime checks the viewer may join.
 * A null id names no room yet: nothing is joined until it does.
 */
export function useRoom({ join, leave }: RoomEvents, id: string | null): void {
  const realtime = useContext(RealtimeContext);
  if (!realtime) throw new Error('useRoom must be used inside <RealtimeProvider>');

  useEffect(() => {
    if (id === null) return;
    const socket = realtime.socket();
    const enter = () => {
      socket.emit(join, id);
    };
    if (socket.connected) enter();
    socket.on('connect', enter);
    return () => {
      socket.off('connect', enter);
      // A dropped socket is in no room; a queued leave would only reach the next one.
      if (socket.connected) socket.emit(leave, id);
    };
  }, [realtime, join, leave, id]);
}
