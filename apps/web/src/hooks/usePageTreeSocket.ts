import { useEffect, useCallback, useRef } from 'react';
import { usePageTree } from './usePageTree';
import { useSocket } from './useSocket';
import { PageEventPayload } from '@/lib/websocket';

/**
 * Enhanced version of usePageTree that listens for real-time page events
 * and automatically revalidates the tree when changes occur
 */
export function usePageTreeSocket(driveId?: string, trashView?: boolean) {
  const socket = useSocket();
  const socketId = socket?.id;
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
  
  // Debounced revalidation to handle rapid consecutive operations
  const revalidationTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  
  const debouncedRevalidate = useCallback(() => {
    if (revalidationTimeoutRef.current) {
      clearTimeout(revalidationTimeoutRef.current);
    }
    
    revalidationTimeoutRef.current = setTimeout(() => {
      console.log('🌳 Executing debounced tree revalidation');
      invalidateTree();
    }, 100); // 100ms debounce
  }, [invalidateTree]);

  const handleContentUpdatedEvent = useCallback((eventData: PageEventPayload) => {
    // Skip tree updates for local writes from this exact socket.
    // This prevents update loops and extra paint while typing.
    if (eventData.socketId && socketId && eventData.socketId === socketId) {
      return;
    }

    if (!eventData.pageId) {
      debouncedRevalidate();
      return;
    }

    // Keep strict correctness for events without socket metadata
    // (e.g. server-side or tool-originated updates).
    if (!eventData.socketId) {
      debouncedRevalidate();
      return;
    }

    const nodeUpdates: {
      title?: string;
      parentId?: string | null;
      hasChanges?: boolean;
    } = {};

    if (eventData.title !== undefined) {
      nodeUpdates.title = eventData.title;
    }
    if (eventData.parentId !== undefined) {
      nodeUpdates.parentId = eventData.parentId;
    }

    // Mark remote content changes immediately without full tree revalidation.
    nodeUpdates.hasChanges = true;

    updateNode(eventData.pageId, nodeUpdates);
  }, [socketId, updateNode, debouncedRevalidate]);

  // Handle page events
  const handlePageEvent = useCallback((eventData: PageEventPayload) => {
    if (eventData.driveId !== currentDriveRef.current) {
      return;
    }

    console.log(`🚀 SOCKET.IO EVENT: ${eventData.operation} for page "${eventData.title || eventData.pageId}" in drive ${eventData.driveId}`);

    if (eventData.operation === 'content-updated') {
      handleContentUpdatedEvent(eventData);
      return;
    }

    debouncedRevalidate();
  }, [debouncedRevalidate, handleContentUpdatedEvent]);

  // Set up Socket.IO listeners for the current drive
  useEffect(() => {
    currentDriveRef.current = driveId;
    
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
  }, [socketId, driveId, handlePageEvent]); // socket intentionally omitted - only depends on ID for stability

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
    socketId: socketId || null,
  };
}
