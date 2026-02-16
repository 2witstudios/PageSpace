/**
 * usePageContentSocket - Subscribe to page content updates via Socket.IO
 *
 * This hook ensures page views receive real-time content updates even when
 * the page is in a different drive than the one displayed in the page tree.
 *
 * Problem it solves:
 * - Page events are broadcast per-drive: `drive:${driveId}`
 * - The page tree only subscribes to the currently-viewed drive
 * - If a user views a page from Drive B while the tree shows Drive A,
 *   content updates won't be received
 *
 * Solution:
 * - Page views independently join their page's drive room
 * - Server validates membership via getUserDriveAccess() - tenant isolation preserved
 * - This is SEPARATE from usePageTreeSocket which handles tree updates
 */

import { useEffect, useCallback, useRef } from 'react';
import { useSocket } from './useSocket';
import { PageEventPayload } from '@/lib/websocket';

export interface UsePageContentSocketOptions {
  /** Called when content is updated for this page */
  onContentUpdated: (payload: PageEventPayload) => void;
  /** Whether to listen for updates (defaults to true) */
  enabled?: boolean;
}

/**
 * Hook to subscribe to a page's drive room for content updates.
 *
 * @param pageId - The page ID to listen for updates
 * @param driveId - The drive ID to join (for receiving events)
 * @param options - Configuration options including the update callback
 */
export function usePageContentSocket(
  pageId: string | undefined,
  driveId: string | undefined,
  options: UsePageContentSocketOptions
) {
  const { onContentUpdated, enabled = true } = options;
  const socket = useSocket();
  const socketId = socket?.id;
  const currentDriveRef = useRef<string | undefined>(undefined);

  const handleContentUpdate = useCallback((eventData: PageEventPayload) => {
    // Only handle events for our specific page
    if (eventData.pageId !== pageId) return;

    // Skip events from this socket to prevent loops
    if (eventData.socketId && socketId && eventData.socketId === socketId) return;

    onContentUpdated(eventData);
  }, [pageId, socketId, onContentUpdated]);

  useEffect(() => {
    if (!socket || !driveId || !pageId || !enabled) return;

    // Track the drive we're joining
    const previousDrive = currentDriveRef.current;
    currentDriveRef.current = driveId;

    // Leave previous drive if different (handles page navigation across drives)
    if (previousDrive && previousDrive !== driveId) {
      socket.emit('leave_drive', previousDrive);
    }

    // Join the page's drive room
    // Server validates membership via getUserDriveAccess() - tenant isolation preserved
    socket.emit('join_drive', driveId);

    // Listen for content updates
    socket.on('page:content-updated', handleContentUpdate);

    return () => {
      socket.off('page:content-updated', handleContentUpdate);
      // Note: We don't leave the drive on unmount because:
      // 1. usePageTreeSocket may also be subscribed to this drive
      // 2. Server cleans up room membership on disconnect
      // 3. Leaving prematurely could cause missed events during navigation
    };
  }, [socket, socketId, driveId, pageId, enabled, handleContentUpdate]);

  return {
    isConnected: !!socket?.connected,
    socketId: socketId || null,
  };
}
