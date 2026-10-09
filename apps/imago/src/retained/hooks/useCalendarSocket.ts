import { useCallback, useEffect, useRef } from 'react';
import { useSocket } from './useSocket';

interface UseCalendarSocketOptions {
  context: 'user' | 'drive';
  driveId?: string;
  onCalendarChanged: () => void;
}

const CALENDAR_EVENTS = ['calendar:created', 'calendar:updated', 'calendar:deleted', 'calendar:rsvp_updated'] as const;

/**
 * Subscribe to calendar socket events and trigger a refresh callback.
 *
 * For drive context, this hook ensures the user joins the drive rooms
 * so drive calendar broadcasts are received.
 */
export function useCalendarSocket({ context, driveId, onCalendarChanged }: UseCalendarSocketOptions) {
  const socket = useSocket();
  const joinedDriveIdRef = useRef<string | null>(null);
  const debounceRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const debouncedRefresh = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      onCalendarChanged();
    }, 200);
  }, [onCalendarChanged]);

  useEffect(() => {
    if (!socket) {
      return;
    }

    const handleCalendarEvent = () => {
      debouncedRefresh();
    };

    for (const eventName of CALENDAR_EVENTS) {
      socket.on(eventName, handleCalendarEvent);
    }

    return () => {
      for (const eventName of CALENDAR_EVENTS) {
        socket.off(eventName, handleCalendarEvent);
      }
    };
  }, [socket, debouncedRefresh]);

  useEffect(() => {
    if (!socket || context !== 'drive' || !driveId) {
      return;
    }

    const joinDrive = () => {
      if (!socket.connected) return;

      if (joinedDriveIdRef.current && joinedDriveIdRef.current !== driveId) {
        socket.emit('leave_drive', joinedDriveIdRef.current);
        joinedDriveIdRef.current = null;
      }

      if (joinedDriveIdRef.current !== driveId) {
        socket.emit('join_drive', driveId);
        joinedDriveIdRef.current = driveId;
      }
    };

    // Join immediately if already connected
    joinDrive();

    // Re-join on reconnection (socket object persists across reconnects)
    socket.on('connect', joinDrive);

    return () => {
      socket.off('connect', joinDrive);
    };
  }, [socket, context, driveId]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      // Note: We don't leave the drive on unmount because:
      // 1. Other hooks (usePageTreeSocket, usePageContentSocket) may share the drive room
      // 2. Server cleans up room membership on disconnect
      // 3. Leaving prematurely could cause missed events for other components
    };
  }, []);
}
