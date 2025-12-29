import { useEffect, useRef, useCallback } from 'react';
import { useSocket } from './useSocket';

export type ActivityContext = 'drive' | 'page';

interface UseActivitySocketOptions {
  context: ActivityContext;
  contextId: string | null;
  onActivityLogged: () => void;
}

/**
 * Hook that listens for activity events and triggers a callback when activities are logged.
 * Joins the appropriate activity room based on context and debounces rapid events.
 */
export function useActivitySocket({
  context,
  contextId,
  onActivityLogged,
}: UseActivitySocketOptions) {
  const socket = useSocket();
  const hasJoinedRef = useRef(false);
  const debounceRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const currentContextRef = useRef<string | null>(null);

  // Stable callback ref to avoid effect re-runs
  const onActivityLoggedRef = useRef(onActivityLogged);
  onActivityLoggedRef.current = onActivityLogged;

  const debouncedRefetch = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      onActivityLoggedRef.current();
    }, 300); // 300ms client-side debounce (server already debounces at 500ms)
  }, []);

  useEffect(() => {
    if (!socket || !contextId) {
      return;
    }

    const joinEvent = context === 'drive' ? 'join_activity_drive' : 'join_activity_page';
    const contextKey = `${context}:${contextId}`;

    // Leave previous room if context changed
    if (currentContextRef.current && currentContextRef.current !== contextKey && hasJoinedRef.current) {
      const [prevContext, prevId] = currentContextRef.current.split(':');
      const prevLeaveEvent = prevContext === 'drive' ? 'leave_activity_drive' : 'leave_activity_page';
      socket.emit(prevLeaveEvent, prevId);
      hasJoinedRef.current = false;
    }

    // Join new room
    if (!hasJoinedRef.current || currentContextRef.current !== contextKey) {
      socket.emit(joinEvent, contextId);
      hasJoinedRef.current = true;
      currentContextRef.current = contextKey;
    }

    // Listen for activity events
    const handleActivityLogged = () => {
      debouncedRefetch();
    };

    socket.on('activity:logged', handleActivityLogged);

    return () => {
      socket.off('activity:logged', handleActivityLogged);
    };
  }, [socket, context, contextId, debouncedRefetch]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      // Leave room on unmount
      if (socket?.connected && hasJoinedRef.current && currentContextRef.current) {
        const [prevContext, prevId] = currentContextRef.current.split(':');
        const leaveEvent = prevContext === 'drive' ? 'leave_activity_drive' : 'leave_activity_page';
        socket.emit(leaveEvent, prevId);
        hasJoinedRef.current = false;
      }
    };
  }, [socket]);

  return {
    isSocketConnected: !!socket?.connected,
  };
}
