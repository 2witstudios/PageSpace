import { useEffect } from 'react';
import { useAuth } from './use-auth';
import { useSocketStore } from '@/stores/socketStore';

export function useSocket() {
  const { isAuthenticated, user } = useAuth();
  const { connect, disconnect, getSocket } = useSocketStore();

  useEffect(() => {
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
  }, [isAuthenticated, user, connect, disconnect]);

  return getSocket();
}