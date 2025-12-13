import { useEffect, useCallback, useRef } from 'react';
import { useSocket } from './useSocket';
import { useDriveStore } from './useDrive';
import { DriveEventPayload, DriveMemberEventPayload } from '@/lib/websocket';

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
      fetchDrives(true, true); // Force refresh to bypass cache
    }, 500); // 500ms debounce
  }, [fetchDrives]);

  // Handle drive events (including member events)
  const handleDriveEvent = useCallback((eventData: DriveEventPayload | DriveMemberEventPayload) => {
    const operation = eventData.operation;

    console.log(`🚀 GLOBAL DRIVE EVENT: ${operation}`, eventData);

    switch (operation) {
      case 'created':
      case 'updated':
      case 'deleted':
      case 'member_added':
      case 'member_role_changed':
      case 'member_removed':
        console.log(`🌍 Drive ${operation}, refetching drives list`);
        debouncedRefetch();
        break;

      default:
        console.log('🌍 Unknown drive operation:', operation);
    }
  }, [debouncedRefetch]);

  // Set up Socket.IO listeners for global drive events
  useEffect(() => {
    if (!socket) {
      console.log('🌍 Socket not available for global drive events');
      return;
    }

    console.log('🌍 useGlobalDriveSocket: Setting up global drive listeners');

    // Join the global drives channel AND user-specific drives channel
    if (!hasJoinedRef.current) {
      socket.emit('join_global_drives');
      socket.emit('join', `user:${socket.id}:drives`); // Join user-specific channel for member events
      hasJoinedRef.current = true;
      console.log('🌍 Joined global:drives and user:drives channels');
    }

    // Listen for drive events (both global and user-specific)
    const events = [
      'drive:created',
      'drive:updated',
      'drive:deleted',
      'drive:member_added',
      'drive:member_role_changed',
      'drive:member_removed'
    ];
    
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
      
      // Leave the global drives channel and user-specific drives channel when unmounting
      if (socket && hasJoinedRef.current) {
        socket.emit('leave_global_drives');
        socket.emit('leave', `user:${socket.id}:drives`);
        hasJoinedRef.current = false;
        console.log('🌍 Left global:drives and user:drives channels');
      }
    };
  }, [socket]);

  return {
    isSocketConnected: !!socket?.connected,
    socketId: socket?.id || null,
  };
}