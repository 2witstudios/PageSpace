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
