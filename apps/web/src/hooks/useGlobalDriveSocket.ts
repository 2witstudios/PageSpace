import { useEffect, useCallback, useRef } from 'react';
import { useSocket } from './useSocket';
import { useDriveStore } from './useDrive';
import { DriveEventPayload } from '@/lib/socket-utils';

/**
 * Hook that listens for global drive events and updates the drive store
 * Ensures real-time synchronization when drives are created, updated, or deleted
 */
export function useGlobalDriveSocket() {
  const socket = useSocket();
  const { fetchDrives } = useDriveStore();
  
  // Track if we've joined the global drives channel
  const hasJoinedRef = useRef(false);
  
  // Debounced refetch to handle rapid consecutive operations
  const revalidationTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  
  const debouncedRefetch = useCallback(() => {
    if (revalidationTimeoutRef.current) {
      clearTimeout(revalidationTimeoutRef.current);
    }
    
    revalidationTimeoutRef.current = setTimeout(() => {
      console.log('🌍 Executing debounced drives refetch');
      fetchDrives();
    }, 500); // 500ms debounce
  }, [fetchDrives]);

  // Handle drive events
  const handleDriveEvent = useCallback((eventData: DriveEventPayload) => {
    console.log(`🚀 GLOBAL DRIVE EVENT: ${eventData.operation} for drive "${eventData.name || eventData.driveId}"`);
    
    switch (eventData.operation) {
      case 'created':
        // For created drives, immediately refetch to get the full drive object
        console.log('🌍 New drive created, refetching drives list');
        debouncedRefetch();
        break;
        
      case 'updated':
        // For updates, refetch to get the latest data
        console.log('🌍 Drive updated, refetching drives list');
        debouncedRefetch();
        break;
        
      case 'deleted':
        // For deletions, refetch to remove from list
        console.log('🌍 Drive deleted, refetching drives list');
        debouncedRefetch();
        break;
        
      default:
        console.log('🌍 Unknown drive operation:', eventData.operation);
    }
  }, [debouncedRefetch]);

  // Set up Socket.IO listeners for global drive events
  useEffect(() => {
    if (!socket) {
      console.log('🌍 Socket not available for global drive events');
      return;
    }

    console.log('🌍 useGlobalDriveSocket: Setting up global drive listeners');

    // Join the global drives channel
    if (!hasJoinedRef.current) {
      socket.emit('join_global_drives');
      hasJoinedRef.current = true;
      console.log('🌍 Joined global:drives channel');
    }
    
    // Listen for drive events
    const events = ['drive:created', 'drive:updated', 'drive:deleted'];
    
    events.forEach(event => {
      socket.on(event, handleDriveEvent);
      console.log(`🌍 Listening for ${event}`);
    });

    // Cleanup function
    return () => {
      console.log('🌍 useGlobalDriveSocket: Cleaning up global drive listeners');
      
      // Remove all event listeners
      events.forEach(event => {
        socket.off(event, handleDriveEvent);
      });
      
      // Clear any pending debounced refetch
      if (revalidationTimeoutRef.current) {
        clearTimeout(revalidationTimeoutRef.current);
        revalidationTimeoutRef.current = undefined;
      }
    };
  }, [socket, handleDriveEvent]);

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (revalidationTimeoutRef.current) {
        clearTimeout(revalidationTimeoutRef.current);
      }
      
      // Leave the global drives channel when unmounting
      if (socket && hasJoinedRef.current) {
        socket.emit('leave_global_drives');
        hasJoinedRef.current = false;
        console.log('🌍 Left global:drives channel');
      }
    };
  }, [socket]);

  return {
    isSocketConnected: !!socket?.connected,
    socketId: socket?.id || null,
  };
}