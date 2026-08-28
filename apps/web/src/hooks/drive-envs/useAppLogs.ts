import { useEffect, useRef, useState } from 'react';
import { useSocket } from '@/hooks/useSocket';

const MAX_LINES = 500;

export interface AppLogLine {
  message: string;
  timestamp: string;
}

/**
 * Tails one published app's live log stream over the shared realtime socket.
 *
 * Contract with the realtime bridge (`apps/realtime`): the client emits
 * `app:logs:subscribe` with `{ flyAppName }` to attach and `app:logs:unsubscribe`
 * with `{ flyAppName }` to detach, and the server emits `app:logs:line` with
 * `{ flyAppName, message, timestamp }` to every subscriber of that app. Only one
 * subscription is ever live per mounted viewer — attaching again on a
 * `flyAppName` change detaches the previous one first.
 *
 * A capped, non-virtualized buffer (last 500 lines) is deliberate: this is a
 * tail viewer for "is my app doing what I expect", not a log archive — anything
 * further back belongs in a real log search, not this pane.
 */
export function useAppLogs(flyAppName: string | null): AppLogLine[] {
  const socket = useSocket();
  const [lines, setLines] = useState<AppLogLine[]>([]);
  const subscribedTo = useRef<string | null>(null);

  useEffect(() => {
    setLines([]);
  }, [flyAppName]);

  useEffect(() => {
    if (!socket || !flyAppName) return;

    socket.emit('app:logs:subscribe', { flyAppName });
    subscribedTo.current = flyAppName;

    const onLine = (payload: { flyAppName: string; message: string; timestamp: string }) => {
      if (payload.flyAppName !== flyAppName) return;
      setLines((prev) => {
        const next = [...prev, { message: payload.message, timestamp: payload.timestamp }];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };

    socket.on('app:logs:line', onLine);

    return () => {
      socket.off('app:logs:line', onLine);
      if (subscribedTo.current) {
        socket.emit('app:logs:unsubscribe', { flyAppName: subscribedTo.current });
        subscribedTo.current = null;
      }
    };
  }, [socket, flyAppName]);

  return lines;
}
