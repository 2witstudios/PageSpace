import { useEffect, useRef } from 'react';
import { useSocket } from './useSocket';
import { useAuth } from './useAuth';

/**
 * Hook that manages page presence - announces when the current user
 * is viewing a page by emitting join/leave events via Socket.IO.
 *
 * Place this in the component that renders when a user is actively viewing a page
 * (e.g., the content header or page view). When the component unmounts (user
 * navigates away), it automatically announces departure.
 *
 * Note: Viewer state updates are handled by usePageTreeSocket which listens
 * for presence:page_viewers events on the drive room and updates usePresenceStore.
 *
 * @param pageId - The page being viewed
 */
export function usePagePresence(pageId: string | null | undefined) {
  const socket = useSocket();
  const socketId = socket?.id;
  const { user } = useAuth();
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

    return () => {
      // Leave presence when unmounting
      if (socket.connected && currentPageRef.current === pageId) {
        socket.emit('presence:leave_page', { pageId });
        currentPageRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socketId, pageId, user?.id]); // socket intentionally omitted - only depends on ID for stability
}
