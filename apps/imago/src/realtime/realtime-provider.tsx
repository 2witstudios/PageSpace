'use client';

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
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

/** realtime's events for a channel's room (apps/realtime/src/index.ts). */
export const JOIN_CHANNEL = 'join_channel';
export const LEAVE_CHANNEL = 'leave_channel';

/**
 * Keeps this tab in the room of the channel page `pageId` while mounted,
 * where its posts are broadcast as `new_message`: joins once connected and
 * again after every reconnect, and leaves when the channel closes or changes,
 * as classic ChannelView does. Realtime checks the viewer may see it.
 */
export function useChannelRoom(pageId: string): void {
  const realtime = useContext(RealtimeContext);
  if (!realtime) throw new Error('useChannelRoom must be used inside <RealtimeProvider>');

  useEffect(() => {
    const socket = realtime.socket();
    const join = () => {
      socket.emit(JOIN_CHANNEL, pageId);
    };
    if (socket.connected) join();
    socket.on('connect', join);
    return () => {
      socket.off('connect', join);
      // A dropped socket is in no room; a queued leave would only reach the next one.
      if (socket.connected) socket.emit(LEAVE_CHANNEL, pageId);
    };
  }, [realtime, pageId]);
}
