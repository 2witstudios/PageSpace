import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';
import { getCookieValue } from '@/lib/utils/get-cookie-value';

// Handler for auth:refreshed event - defined at module level for cleanup
let handleAuthRefresh: (() => void) | null = null;

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

  connect: async (forceReconnect = false) => {
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

      // Extract access token - different sources for desktop vs web
      let accessToken: string | undefined;

      // Check if running in Electron (desktop app)
      const isDesktop = typeof window !== 'undefined' &&
                       window.electron &&
                       typeof window.electron.auth?.getJWT === 'function';

      if (isDesktop) {
        // Desktop: Get token from Electron secure storage
        try {
          accessToken = await window.electron?.auth.getJWT() ?? undefined;
          console.log('🔌 Desktop: Retrieved token from Electron storage for Socket.IO');
        } catch (error) {
          console.error('🚨 Failed to get JWT from Electron for Socket.IO:', error);
        }
      } else {
        // Web: Extract from cookies using safe utility
        accessToken = getCookieValue('accessToken') ?? undefined;
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
              // Re-check desktop status inside setTimeout to avoid closure issue
              const isDesktopNow = typeof window !== 'undefined' &&
                                   window.electron &&
                                   typeof window.electron.auth?.getJWT === 'function';

              // Desktop uses different refresh endpoint than web
              const refreshEndpoint = isDesktopNow ? '/api/auth/device/refresh' : '/api/auth/refresh';

              let refreshPayload: RequestInit = {
                method: 'POST',
                credentials: 'include',
              };

              // Desktop needs to provide device info for device token refresh
              if (isDesktopNow && window.electron?.auth?.getDeviceInfo) {
                const deviceInfo = await window.electron.auth.getDeviceInfo();
                const session = await window.electron.auth.getSession();

                refreshPayload = {
                  ...refreshPayload,
                  headers: {
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    deviceToken: session?.deviceToken,
                    deviceId: deviceInfo.deviceId,
                    userAgent: navigator.userAgent,
                  }),
                };
              }

              // Try to refresh by making a request to our token refresh endpoint
              const response = await fetch(refreshEndpoint, refreshPayload);

              if (response.ok) {
                console.log('🔄 Token refreshed, reconnecting socket...');

                // Re-fetch the new token from storage/cookies
                let newToken: string | undefined;
                if (isDesktopNow) {
                  newToken = await window.electron?.auth.getJWT() ?? undefined;
                } else {
                  newToken = getCookieValue('accessToken') ?? undefined;
                }

                // Update socket auth with new token BEFORE reconnecting
                if (newToken) {
                  newSocket.auth = { token: newToken };
                }

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

      // Listen for token refresh events to proactively reconnect
      if (typeof window !== 'undefined') {
        // Remove any existing listener to prevent duplicates
        if (handleAuthRefresh) {
          window.removeEventListener('auth:refreshed', handleAuthRefresh);
        }

        // Create new handler that captures the current store reference
        handleAuthRefresh = () => {
          const currentSocket = get().socket;
          if (currentSocket?.connected) {
            console.log('🔄 Token refreshed, proactively reconnecting socket...');
            get().connect(true); // Force reconnect with new token
          }
        };

        window.addEventListener('auth:refreshed', handleAuthRefresh);
      }
    }
  },

  disconnect: () => {
    const { socket } = get();
    if (socket) {
      socket.disconnect();

      // Clean up auth refresh listener
      if (typeof window !== 'undefined' && handleAuthRefresh) {
        window.removeEventListener('auth:refreshed', handleAuthRefresh);
        handleAuthRefresh = null;
      }

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