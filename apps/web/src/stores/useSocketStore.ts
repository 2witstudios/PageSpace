import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

// Handler for auth:refreshed event - defined at module level for cleanup
let handleAuthRefresh: (() => void) | null = null;

/**
 * SINGLE-FLIGHT CONNECT.
 *
 * `connect()` cannot decide "do we already have a socket?" from the store alone, because it
 * `await`s a token fetch BEFORE it can write the new Socket into the store. Roughly thirty
 * call sites reach this store through `useSocket()`, and on a real screen a dozen-plus of them
 * mount in the SAME React commit — so every one of them read `socket === null`, every one
 * called `io()`, and the store ended up with one winner and a pile of live orphans nobody
 * could reach, let alone close.
 *
 * That was not merely wasteful. Each orphan parks a long-poll GET on the app's own origin
 * (production path-routes `/socket.io` to realtime on the app host, so it IS the app's
 * origin), and a browser allows only six concurrent HTTP/1.1 connections per origin. A single
 * commit's worth of orphans exhausts that budget: most sockets never finish their handshake,
 * the survivors never get a free connection to upgrade onto, and the app's ORDINARY fetches
 * queue behind long-polls that by definition never return. Live delivery stops, and so does
 * anything else that needs the network.
 *
 * The in-flight promise is the missing gate: it is published synchronously, before the first
 * `await`, so siblings arriving later in the same tick join it instead of racing it. The
 * generation counter is the second half — a creation that gets superseded (a forced reconnect,
 * a logout) must stand down rather than resurrect itself over the top of newer state.
 */
let pendingConnect: Promise<void> | null = null;
let connectGeneration = 0;

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
  /**
   * Resolves once this call's connection attempt has settled. Callers that only want the
   * socket to exist can ignore it; siblings racing in the same tick all receive the SAME
   * promise, because only the first of them creates anything.
   */
  connect: (forceReconnect?: boolean) => Promise<void>;
  disconnect: () => void;
  getSocket: () => Socket | null;
}

export const useSocketStore = create<SocketStore>((set, get) => {
  /** Mints one Socket. Only ever called through the single-flight gate in `connect`. */
  const openConnection = async (generation: number): Promise<void> => {
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

    // The token fetch above is the window in which this attempt can be superseded — a
    // forced reconnect, or a logout. Minting the socket anyway would either clobber the
    // newer one in the store or leave a live connection with no owner, which is exactly
    // the orphan this gate exists to stop. Stand down instead.
    if (generation !== connectGeneration) return;

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

        // Try getting a fresh socket token first — the session cookie may still be valid,
        // and only the short-lived socket token (5 min) expired. Calling refreshAuthSession()
        // directly would trigger a device token refresh which fails for web users without
        // a device token, causing an unnecessary forced logout.
        setTimeout(async () => {
          try {
            // Guard: if the store socket changed (e.g., disconnect() + connect() called),
            // this timer is stale — bail to avoid reconnecting an orphaned instance.
            if (get().socket !== newSocket) return;

            // Re-check desktop status
            const isDesktopNow = typeof window !== 'undefined' &&
                                 window.electron &&
                                 typeof window.electron.auth?.getSessionToken === 'function';

            if (!isDesktopNow) {
              // Web: Try getting a fresh socket token first (session cookie may still be valid)
              const freshToken = await getSocketToken();
              if (freshToken) {
                if (get().socket !== newSocket) return; // stale after async
                console.log('🔄 Got fresh socket token, reconnecting socket...');
                newSocket.auth = { token: freshToken };
                newSocket.io.opts.reconnection = true;
                newSocket.io.opts.reconnectionAttempts = 15;
                newSocket.connect();
                return;
              }
              // Socket token fetch failed — session cookie likely expired, fall through to full refresh
              console.log('🔄 Socket token fetch failed, attempting full session refresh...');
            }

            // Full session refresh (desktop always uses this; web falls back to it)
            const { refreshAuthSession, clearSessionCache } = await import('@/lib/auth/auth-fetch');
            const result = await refreshAuthSession();

            if (result.success) {
              if (get().socket !== newSocket) return; // stale after async
              console.log('🔄 Token refreshed via unified auth, reconnecting socket...');

              // Clear session cache to ensure fresh token retrieval
              clearSessionCache();

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

    if (typeof window !== 'undefined') {
      if (handleAuthRefresh) {
        window.removeEventListener('auth:refreshed', handleAuthRefresh);
      }

      // Token is consumed only at handshake — a connected socket stays
      // authenticated. Reconnecting it on every refresh cascades into chat
      // refetches (GlobalChatContext, agent multiplayer) that snap the
      // message list to the bottom. Only retry when the socket is down.
      handleAuthRefresh = () => {
        const currentSocket = get().socket;
        if (!currentSocket || currentSocket.connected) return;
        console.log('🔄 Token refreshed, retrying disconnected socket...');
        get().connect(true);
      };

      window.addEventListener('auth:refreshed', handleAuthRefresh);
    }
  };

  return {
    socket: null,
    connectionStatus: 'disconnected',
    isInitialized: false,

    connect: (forceReconnect = false) => {
      const { socket } = get();

      // A socket already exists and nobody asked for a fresh one. Note this covers the
      // MID-HANDSHAKE socket too, not just the connected one: a second `io()` while the
      // first is still shaking hands is precisely the orphan we are here to prevent.
      if (socket && !forceReconnect) return Promise.resolve();

      // No socket in the store yet — but a sibling that mounted microseconds ago is already
      // fetching a token to make one. Join its attempt rather than starting a rival.
      if (pendingConnect && !forceReconnect) return pendingConnect;

      // Forcing: drop the old one first so it cannot keep a transport open behind us.
      if (socket && forceReconnect) socket.disconnect();

      const generation = ++connectGeneration;
      const attempt = openConnection(generation).finally(() => {
        // Only the attempt still holding the slot may clear it; a superseded one clearing it
        // would let its successor be raced all over again.
        if (pendingConnect === attempt) pendingConnect = null;
      });
      pendingConnect = attempt;
      return attempt;
    },

    disconnect: () => {
      // Invalidate anything in flight BEFORE touching the socket. A token fetch that started
      // before this logout would otherwise land afterwards and mint a live socket for a user
      // who is gone — a leak the store would have no handle on.
      connectGeneration += 1;
      pendingConnect = null;

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
  };
});