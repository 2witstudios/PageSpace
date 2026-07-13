import { useEffect } from 'react';
import { useAuth } from './useAuth';
import { useSocketStore } from '@/stores/useSocketStore';

export function useSocket() {
  const { isAuthenticated, user } = useAuth();
  // Subscribe to the socket itself, not the stable getSocket accessor: the
  // store REPLACES the Socket object (initial async creation, and the
  // auth-refresh `connect(true)` path disconnects the old one and mints a new
  // one). A consumer reading through the accessor only noticed a swap on its
  // next incidental re-render — a terminal pane keyed on the socket prop kept
  // listening to a permanently-disconnected Socket whose 'connect' event
  // would never fire again, i.e. a silently dead pane.
  const socket = useSocketStore(state => state.socket);

  useEffect(() => {
    // Get stable methods directly without subscribing (they don't change)
    const { connect, disconnect } = useSocketStore.getState();

    if (isAuthenticated && user) {
      // Connect without logging here - socketStore will log only when actually connecting
      connect();

      // Silent cleanup - no need to log on every component unmount
      return () => {
        // Don't disconnect on component unmount, let the socket persist
        // Only disconnect when user logs out (handled below)
      };
    } else {
      // Only disconnect when user is not authenticated
      disconnect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user?.id]); // user intentionally omitted - only depends on ID for stability

  return socket;
}