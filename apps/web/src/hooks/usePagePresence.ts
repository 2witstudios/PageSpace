import { useEffect, useRef } from 'react';
import { useSocket } from './useSocket';
import { useAuth } from './useAuth';
import { usePresenceStore } from '@/stores/usePresenceStore';
import type { PresencePageViewersPayload } from '@/lib/websocket';

/**
 * Hook that manages page presence - announces when the current user
 * is viewing a page and listens for viewer updates.
 *
 * Place this in the component that renders when a user is actively viewing a page
 * (e.g., the content header or page view). When the component unmounts (user
 * navigates away), it automatically announces departure.
 *
 * @param pageId - The page being viewed
 * @returns Current viewers of this page (excluding the current user)
 */
export function usePagePresence(pageId: string | null | undefined) {
  const socket = useSocket();
  const socketId = socket?.id;
  const { user } = useAuth();
  const setPageViewers = usePresenceStore((state) => state.setPageViewers);
  const currentPageRef = useRef<string | null>(null);

  useEffect(() => {
    if (!socket || !socketId || !pageId || !user?.id) {
      // If we had a previous page, leave it
      if (currentPageRef.current && socket?.connected) {
        socket.emit('presence:leave_page', { pageId: currentPageRef.current });
        currentPageRef.current = null;
      }
      return;
    }

    // If switching pages, leave the old one first
    if (currentPageRef.current && currentPageRef.current !== pageId) {
      socket.emit('presence:leave_page', { pageId: currentPageRef.current });
    }

    currentPageRef.current = pageId;

    // Join the new page's presence
    socket.emit('presence:join_page', { pageId });

    // Listen for viewer updates on this specific page
    const handleViewers = (data: PresencePageViewersPayload) => {
      if (data.pageId === pageId) {
        setPageViewers(data.pageId, data.viewers);
      }
    };

    socket.on('presence:page_viewers', handleViewers);

    return () => {
      socket.off('presence:page_viewers', handleViewers);

      // Leave presence when unmounting
      if (socket.connected && currentPageRef.current === pageId) {
        socket.emit('presence:leave_page', { pageId });
        currentPageRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socketId, pageId, user?.id]); // socket intentionally omitted - only depends on ID for stability
}
