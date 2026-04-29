import { useEffect } from 'react';
import { useSocket } from './useSocket';

export function usePageSocketRoom(pageId: string | undefined): void {
  const socket = useSocket();

  useEffect(() => {
    if (!socket || !pageId) return;
    socket.emit('join_channel', pageId);
  }, [socket, pageId]);
}
