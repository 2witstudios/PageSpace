import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

interface SocketStore {
  socket: Socket | null;
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  isInitialized: boolean;
  connect: (forceReconnect?: boolean) => void;
  disconnect: () => void;
  getSocket: () => Socket | null;
}

export const useSocketStore = create<SocketStore>((set, get) => ({
  socket: null,
  connectionStatus: 'disconnected',
  isInitialized: false,

  connect: (forceReconnect = false) => {
    const { socket } = get();
    
    // If already connected and not forcing reconnect, return existing socket
    if (socket?.connected && !forceReconnect) {
      return;
    }

    // If socket exists but we're forcing reconnect, disconnect first
    if (socket && forceReconnect) {
      socket.disconnect();
    }

    // Only create new socket if we don't have one or forcing reconnect
    if (!socket || forceReconnect) {
      set({ connectionStatus: 'connecting' });

      const socketUrl = process.env.NEXT_PUBLIC_REALTIME_URL;

      // Extract access token from cookies for authentication
      let accessToken: string | undefined;
      if (typeof document !== 'undefined') {
        accessToken = document.cookie
          .split('; ')
          .find(row => row.startsWith('accessToken='))
          ?.split('=')[1];
      }

      // Only log when actually creating a new connection
      console.log('🔌 Creating new Socket.IO connection for realtime features');
      
      const newSocket = io(socketUrl, {
        auth: {
          token: accessToken,
        },
        withCredentials: true, // This sends cookies including httpOnly ones
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        randomizationFactor: 0.5,
        autoConnect: true,
      });

      // Connection event handlers
      newSocket.on('connect', () => {
        console.log('✅ Socket.IO connected successfully:', newSocket.id);
        set({ connectionStatus: 'connected' });
      });

      newSocket.on('connect_error', (error) => {
        console.error('🚨 Socket.IO connection error:', error.message);
        set({ connectionStatus: 'error' });
        
        // Handle auth errors differently - don't spam reconnect
        if (error.message.includes('Authentication error')) {
          console.log('🔄 Auth error detected, will retry after token refresh...');
          // Stop automatic reconnection for auth errors
          newSocket.io.opts.reconnection = false;
          
          // Attempt token refresh after a delay
          setTimeout(async () => {
            try {
              // Try to refresh by making a request to our token refresh endpoint
              const response = await fetch('/api/auth/refresh', {
                method: 'POST',
                credentials: 'include'
              });
              
              if (response.ok) {
                console.log('🔄 Token refreshed, reconnecting socket...');
                // Re-enable reconnection and connect
                newSocket.io.opts.reconnection = true;
                newSocket.connect();
              } else {
                console.error('🚨 Failed to refresh token for Socket.IO');
                set({ connectionStatus: 'error' });
              }
            } catch (error) {
              console.error('🚨 Error refreshing token:', error);
              set({ connectionStatus: 'error' });
            }
          }, 2000); // Wait 2 seconds before retry
        }
      });

      newSocket.on('disconnect', (reason) => {
        console.log('🔌 Socket.IO disconnected:', reason);
        set({ connectionStatus: 'disconnected' });
        
        if (reason === 'io server disconnect') {
          // Server disconnected us, will auto-reconnect
          console.log('🔄 Server disconnected, will attempt to reconnect...');
        }
      });

      set({ 
        socket: newSocket, 
        isInitialized: true 
      });
    }
  },

  disconnect: () => {
    const { socket } = get();
    if (socket) {
      socket.disconnect();
      set({ 
        socket: null, 
        connectionStatus: 'disconnected',
        isInitialized: false 
      });
    }
  },

  getSocket: () => {
    return get().socket;
  }
}));