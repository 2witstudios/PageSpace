import { useEffect, useCallback, useRef } from 'react';
import { usePageTree } from './usePageTree';
import { useSocket } from './useSocket';
import { PageEventPayload } from '@/lib/websocket/socket-utils';

/**
 * Enhanced version of usePageTree that listens for real-time page events
 * and automatically revalidates the tree when changes occur
 */
export function usePageTreeSocket(driveId?: string, trashView?: boolean) {
  const socket = useSocket();
  const { 
    tree, 
    isLoading, 
    isError, 
    mutate, 
    updateNode, 
    fetchAndMergeChildren, 
    childLoadingMap, 
    invalidateTree 
  } = usePageTree(driveId, trashView);

  // Track the current drive to avoid unnecessary revalidations
  const currentDriveRef = useRef<string | undefined>(driveId);
  const currentDriveIdRef = useRef<string | undefined>(driveId);
  
  // Debounced revalidation to handle rapid consecutive operations
  const revalidationTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  
  const debouncedRevalidate = useCallback(() => {
    if (revalidationTimeoutRef.current) {
      clearTimeout(revalidationTimeoutRef.current);
    }
    
    revalidationTimeoutRef.current = setTimeout(() => {
      console.log('🌳 Executing debounced tree revalidation');
      invalidateTree();
    }, 100); // 100ms debounce
  }, [invalidateTree]);

  // Handle page events
  const handlePageEvent = useCallback((eventData: PageEventPayload) => {
    // Only revalidate if the event is for the current drive
    if (eventData.driveId === currentDriveRef.current) {
      console.log(`🚀 SOCKET.IO EVENT: ${eventData.operation} for page "${eventData.title || eventData.pageId}" in drive ${eventData.driveId}`);
      debouncedRevalidate();
    }
  }, [debouncedRevalidate]);

  // Set up Socket.IO listeners for the current drive
  useEffect(() => {
    currentDriveRef.current = driveId;
    currentDriveIdRef.current = driveId;
    
    if (!socket || !driveId) {
      return;
    }

    console.log('🌳 usePageTreeSocket: Setting up listeners for drive:', driveId);

    // Join the drive room to receive page events (using drive ID)
    socket.emit('join_drive', driveId);
    
    // Listen for page events
    const events = ['page:created', 'page:updated', 'page:moved', 'page:trashed', 'page:restored', 'page:content-updated'];
    
    events.forEach(event => {
      socket.on(event, handlePageEvent);
    });

    // Cleanup function
    return () => {
      console.log('🌳 usePageTreeSocket: Cleaning up listeners for drive:', driveId);
      
      // Leave the drive room (using drive ID)
      if (driveId) {
        socket.emit('leave_drive', driveId);
      }
      
      // Remove all event listeners
      events.forEach(event => {
        socket.off(event, handlePageEvent);
      });
      
      // Clear any pending debounced revalidation
      if (revalidationTimeoutRef.current) {
        clearTimeout(revalidationTimeoutRef.current);
        revalidationTimeoutRef.current = undefined;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket?.id, driveId, handlePageEvent]); // socket intentionally omitted - only depends on ID for stability

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (revalidationTimeoutRef.current) {
        clearTimeout(revalidationTimeoutRef.current);
      }
    };
  }, []);

  return {
    tree,
    isLoading,
    isError,
    mutate,
    updateNode,
    fetchAndMergeChildren,
    childLoadingMap,
    invalidateTree,
    // Additional properties for socket status
    isSocketConnected: !!socket?.connected,
    socketId: socket?.id || null,
  };
}