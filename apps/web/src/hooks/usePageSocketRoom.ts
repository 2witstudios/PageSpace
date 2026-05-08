import { useEffect } from 'react';
import { useSocket } from './useSocket';

export function usePageSocketRoom(pageId: string | undefined): void {
  const socket = useSocket();

  useEffect(() => {
    if (!socket || !pageId) return;
    const join = () => {
      if (!socket.connected) return;
      socket.emit('join_channel', pageId);
    };
    join();
    socket.on('connect', join);
    return () => {
      socket.off('connect', join);
      if (socket.connected) socket.emit('leave_channel', pageId);
    };
  }, [socket, pageId]);
}
