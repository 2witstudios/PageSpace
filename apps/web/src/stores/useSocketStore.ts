import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

// Handler for auth:refreshed event - defined at module level for cleanup
let handleAuthRefresh: (() => void) | null = null;

/**
 * Fetch a short-lived socket token from the server.
 * This bypasses sameSite: 'strict' cookie restrictions by using same-origin fetch.
 */
async function getSocketToken(): Promise<string | null> {
  try {
    const response = await fetch('/api/auth/socket-token', {
      credentials: 'include', // Send httpOnly cookies
    });
    if (!response.ok) {
      console.warn('Failed to fetch socket token:', response.status);
      return null;
    }
    const data = await response.json();
    return data.token;
  } catch (error) {
    console.error('Error fetching socket token:', error);
    return null;
  }
}

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

      const socketUrl = process.env.NEXT_PUBLIC_REALTIME_URL || undefined;

      // Extract auth token - different sources for desktop vs web
      let authToken: string | undefined;

      // Check if running in Electron (desktop app)
      const isDesktop = typeof window !== 'undefined' &&
                       window.electron &&
                       typeof window.electron.auth?.getSessionToken === 'function';

      if (isDesktop) {
        // Desktop: Get session token from Electron secure storage
        try {
          authToken = await window.electron?.auth.getSessionToken() ?? undefined;
          console.log('🔌 Desktop: Retrieved session token from Electron storage for Socket.IO');
        } catch (error) {
          console.error('🚨 Failed to get session token from Electron for Socket.IO:', error);
        }
      } else {
        // Web: Fetch short-lived socket token from server
        // This bypasses sameSite: 'strict' cookie restrictions
        authToken = await getSocketToken() ?? undefined;
        if (authToken) {
          console.log('🔌 Web: Retrieved socket token for Socket.IO');
        }
      }

      // Only log when actually creating a new connection
      console.log('🔌 Creating new Socket.IO connection for realtime features');

      const newSocket = io(socketUrl, {
        auth: {
          token: authToken,
        },
        withCredentials: true, // This sends cookies including httpOnly ones
        reconnection: true,
        reconnectionAttempts: 15,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 30000,
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

        // Handle auth errors differently - pause reconnect during token refresh
        if (error.message.includes('Authentication error')) {
          console.log('🔄 Auth error detected, will retry after token refresh...');
          // Pause automatic reconnection during token refresh attempt
          newSocket.io.opts.reconnection = false;

          // Attempt token refresh after a delay using the unified auth-fetch mechanism
          // CRITICAL: Use refreshAuthSession() to share deduplication with other refresh paths
          setTimeout(async () => {
            try {
              const { refreshAuthSession, clearSessionCache } = await import('@/lib/auth/auth-fetch');
              const result = await refreshAuthSession();

              if (result.success) {
                console.log('🔄 Token refreshed via unified auth, reconnecting socket...');

                // Clear session cache to ensure fresh token retrieval
                clearSessionCache();

                // Re-check desktop status
                const isDesktopNow = typeof window !== 'undefined' &&
                                     window.electron &&
                                     typeof window.electron.auth?.getSessionToken === 'function';

                // Re-fetch the new token from storage or socket-token endpoint
                let newToken: string | undefined;
                if (isDesktopNow) {
                  newToken = await window.electron?.auth.getSessionToken() ?? undefined;
                } else {
                  newToken = await getSocketToken() ?? undefined;
                }

                // Update socket auth with new token BEFORE reconnecting
                if (newToken) {
                  newSocket.auth = { token: newToken };
                }

                // Re-enable reconnection and reset attempt counter
                newSocket.io.opts.reconnection = true;
                newSocket.io.opts.reconnectionAttempts = 15;
                newSocket.connect();
              } else {
                // Don't log error if shouldLogout is true - user will be redirected
                if (!result.shouldLogout) {
                  console.error('🚨 Failed to refresh token for Socket.IO (will retry)');
                }
                // Re-enable reconnection so socket can retry later
                newSocket.io.opts.reconnection = true;
                set({ connectionStatus: 'error' });
              }
            } catch (error) {
              console.error('🚨 Error refreshing token:', error);
              // Re-enable reconnection so socket can retry later
              newSocket.io.opts.reconnection = true;
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