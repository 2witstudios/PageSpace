import { useEffect } from 'react';
import { useAuth } from './useAuth';
import { useSocketStore } from '@/stores/useSocketStore';

export function useSocket() {
  const { isAuthenticated, user } = useAuth();
  const getSocket = useSocketStore(state => state.getSocket);

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

  return getSocket();
}