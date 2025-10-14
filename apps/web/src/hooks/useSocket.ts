import { useEffect } from 'react';
import { useAuth } from './use-auth';
import { useSocketStore } from '@/stores/socketStore';

export function useSocket() {
  const { isAuthenticated, user } = useAuth();
  const getSocket = useSocketStore(state => state.getSocket);

  useEffect(() => {
    // Get stable methods directly without subscribing (they don't change)
    const { connect, disconnect } = useSocketStore.getState();

    if (isAuthenticated && user) {
      console.log('🔌 Initializing Socket.IO connection for user:', user.id);
      connect();

      return () => {
        // Don't disconnect on component unmount, let the socket persist
        // Only disconnect when user logs out (handled below)
        console.log('🔌 useSocket cleanup (keeping connection alive)');
      };
    } else {
      // Only disconnect when user is not authenticated
      console.log('🔌 User not authenticated, disconnecting socket');
      disconnect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user?.id]); // user intentionally omitted - only depends on ID for stability

  return getSocket();
}