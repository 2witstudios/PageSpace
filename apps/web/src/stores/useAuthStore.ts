'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface User {
  id: string;
  name: string | null;
  email: string | null;
  image?: string | null;
  emailVerified?: Date | null;
  role?: 'user' | 'admin';
}

interface AuthState {
  // Auth state
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  lastAuthCheck: number | null;
  hasHydrated: boolean;

  // Token refresh state
  isRefreshing: boolean;
  refreshTimeoutId: NodeJS.Timeout | null;

  // CSRF protection state
  csrfToken: string | null;

  // Session state
  sessionStartTime: number | null;
  lastActivity: number | null;
  lastActivityUpdate: number | null; // Track when we last updated activity

  // Failed auth attempt tracking
  failedAuthAttempts: number;
  lastFailedAuthCheck: number | null;

  // Deduplication state
  _authPromise: Promise<void> | null; // Track in-flight auth requests
  _serverSessionInitialized: boolean; // Track if server session was loaded

  // Actions
  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
  setRefreshing: (refreshing: boolean) => void;
  setRefreshTimeout: (timeoutId: NodeJS.Timeout | null) => void;
  setCsrfToken: (token: string | null) => void;
  setHydrated: (hydrated: boolean) => void;
  updateActivity: () => void;
  startSession: () => void;
  endSession: () => void;
  recordFailedAuth: () => void;
  clearFailedAttempts: () => void;
  reset: () => void;
  loadSession: (force?: boolean) => Promise<void>;
  initializeFromServer: (initialUser: User | null) => void;
}

const ACTIVITY_TIMEOUT = 60 * 60 * 1000; // 60 minutes (more forgiving)
const AUTH_CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes (token refresh handles validation every 12 min)
const ACTIVITY_UPDATE_THROTTLE = 5 * 1000; // Only update activity every 5 seconds
const MAX_FAILED_AUTH_ATTEMPTS = 5; // Max failed attempts before circuit breaker (increased for network resilience)
const MAX_FAILED_AUTH_ATTEMPTS_DESKTOP = 10; // Desktop gets more attempts (transient network issues after wake)
const FAILED_AUTH_TIMEOUT = 60 * 1000; // 60 seconds timeout for failed attempts (increased from 30s)

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      // Initial state
      user: null,
      isLoading: false,
      isAuthenticated: false,
      lastAuthCheck: null,
      hasHydrated: false,
      isRefreshing: false,
      refreshTimeoutId: null,
      csrfToken: null,
      sessionStartTime: null,
      lastActivity: null,
      lastActivityUpdate: null,
      failedAuthAttempts: 0,
      lastFailedAuthCheck: null,
      _authPromise: null,
      _serverSessionInitialized: false,

      // Actions
      setUser: (user) => {
        set((state) => ({
          user,
          isAuthenticated: !!user,
          lastAuthCheck: Date.now(),
          // Start session if user is set and session not already started
          sessionStartTime: user && !state.sessionStartTime ? Date.now() : state.sessionStartTime,
          lastActivity: user ? Date.now() : state.lastActivity,
          // Clear failed attempts on successful auth
          failedAuthAttempts: user ? 0 : state.failedAuthAttempts,
          lastFailedAuthCheck: user ? null : state.lastFailedAuthCheck,
        }));
      },

      setLoading: (isLoading) => set({ isLoading }),

      setRefreshing: (isRefreshing) => set({ isRefreshing }),

      setRefreshTimeout: (refreshTimeoutId) => set({ refreshTimeoutId }),

      setCsrfToken: (csrfToken) => set({ csrfToken }),

      setHydrated: (hasHydrated) => set({ hasHydrated }),

      updateActivity: () => {
        const now = Date.now();
        const state = get();
        
        // Only update if user is authenticated and we haven't updated recently
        if (state.isAuthenticated) {
          // Throttle updates to prevent excessive re-renders
          if (!state.lastActivityUpdate || (now - state.lastActivityUpdate) > ACTIVITY_UPDATE_THROTTLE) {
            set({ 
              lastActivity: now,
              lastActivityUpdate: now 
            });
          }
        }
      },

      startSession: () => set({
        sessionStartTime: Date.now(),
        lastActivity: Date.now(),
      }),

      endSession: () => {
        const state = get();

        // Clear any pending refresh timeout
        if (state.refreshTimeoutId) {
          clearTimeout(state.refreshTimeoutId);
        }

        // Clear CSRF token from authFetch
        if (typeof window !== 'undefined') {
          import('@/lib/auth/auth-fetch').then(({ clearCSRFToken }) => {
            clearCSRFToken();
          });
        }

        set({
          user: null,
          isAuthenticated: false,
          sessionStartTime: null,
          lastActivity: null,
          refreshTimeoutId: null,
          isRefreshing: false,
          csrfToken: null,
        });
      },

      recordFailedAuth: () => {
        set((state) => ({
          failedAuthAttempts: state.failedAuthAttempts + 1,
          lastFailedAuthCheck: Date.now(),
        }));
      },

      clearFailedAttempts: () => {
        set({
          failedAuthAttempts: 0,
          lastFailedAuthCheck: null,
        });
      },

      reset: () => {
        const state = get();

        // Clear any pending refresh timeout
        if (state.refreshTimeoutId) {
          clearTimeout(state.refreshTimeoutId);
        }

        set({
          user: null,
          isLoading: false,
          isAuthenticated: false,
          lastAuthCheck: null,
          isRefreshing: false,
          refreshTimeoutId: null,
          sessionStartTime: null,
          lastActivity: null,
          lastActivityUpdate: null,
          failedAuthAttempts: 0,
          lastFailedAuthCheck: null,
          _authPromise: null,
          _serverSessionInitialized: false,
        });
      },

      // Initialize store with server session data (prevents initial auth check spam)
      initializeFromServer: (initialUser) => {
        set({
          user: initialUser,
          isAuthenticated: !!initialUser,
          lastAuthCheck: Date.now(),
          _serverSessionInitialized: true,
          sessionStartTime: initialUser ? Date.now() : null,
          lastActivity: initialUser ? Date.now() : null,
        });
      },

      // Deduplicated session loading with promise caching
      loadSession: async (force = false) => {
        const state = get();

        // Return existing promise if already loading (deduplication)
        if (state._authPromise && !force) {
          return state._authPromise;
        }

        // Skip if circuit breaker is active
        if (!force && authStoreHelpers.shouldSkipAuthCheck()) {
          const isDesktop = typeof window !== 'undefined' && window.electron?.isDesktop;

          if (isDesktop) {
            // Desktop: Don't clear user state on circuit breaker - network may be recovering
            // after sleep/wake. Just skip this check and rely on token refresh to recover.
            console.log('[AUTH_STORE] Circuit breaker active (desktop) - skipping auth check, keeping user state');
            set({ isLoading: false });
            return;
          }

          // Web: Clear user state to force re-login (web has more stable connectivity)
          console.log('[AUTH_STORE] Circuit breaker active - clearing user state');
          set({
            user: null,
            isAuthenticated: false,
            isLoading: false,
          });
          return;
        }

        // Set loading state to prevent premature redirects (critical for OAuth flow)
        set({ isLoading: true });

        // Create new auth promise
        const authPromise = (async () => {
          try {
            const isDesktop = typeof window !== 'undefined' && window.electron?.isDesktop;
            const headers: Record<string, string> = {};

            if (isDesktop && window.electron) {
              const jwt = await window.electron.auth.getJWT();
              if (jwt) {
                headers['Authorization'] = `Bearer ${jwt}`;
              }
            }

            const response = await fetch('/api/auth/me', {
              credentials: 'include',
              headers,
            });

            if (response.ok) {
              const userData = await response.json();
              const currentUser = get().user;

              // Check if user data actually changed (prevent unnecessary re-renders)
              const hasChanged = !currentUser ||
                currentUser.id !== userData.id ||
                currentUser.name !== userData.name ||
                currentUser.email !== userData.email ||
                currentUser.image !== userData.image ||
                currentUser.emailVerified !== userData.emailVerified;

              if (hasChanged) {
                // Data changed - update everything
                set({
                  user: userData,
                  isAuthenticated: true,
                  lastAuthCheck: Date.now(),
                  failedAuthAttempts: 0,
                  lastFailedAuthCheck: null,
                });
              } else {
                // Data identical - only update timestamp
                set({
                  lastAuthCheck: Date.now(),
                  failedAuthAttempts: 0,
                  lastFailedAuthCheck: null,
                });
              }

              // Update activity for new session
              get().updateActivity();
            } else if (response.status === 401) {
              // For desktop: use the unified refresh flow which handles device token properly
              if (isDesktop && window.electron) {
                console.log('[AUTH_STORE] Desktop token validation failed, attempting token refresh');

                // Use the unified refresh flow - it handles device token, rate limiting, etc.
                const { refreshAuthSession, clearJWTCache } = await import('@/lib/auth/auth-fetch');
                const refreshResult = await refreshAuthSession();

                if (refreshResult.success) {
                  console.log('[AUTH_STORE] Token refresh succeeded, retrying session load');
                  clearJWTCache();
                  return get().loadSession(true);
                }

                // Only logout if explicitly told to (device token genuinely invalid)
                if (!refreshResult.shouldLogout) {
                  console.log('[AUTH_STORE] Token refresh failed but not fatal - will retry later');
                  // Record failure but don't clear user - might be transient
                  // Use get() to get current value since state may be stale after async operations
                  set({
                    failedAuthAttempts: get().failedAuthAttempts + 1,
                    lastFailedAuthCheck: Date.now(),
                  });
                  return;
                }

                console.log('[AUTH_STORE] Authentication token invalid, user must re-authenticate');
              }

              // Unauthorized - clear user and record failure
              set({
                user: null,
                isAuthenticated: false,
                failedAuthAttempts: get().failedAuthAttempts + 1,
                lastFailedAuthCheck: Date.now(),
              });
            } else {
              // Other errors - record failure but don't clear user
              set({
                failedAuthAttempts: get().failedAuthAttempts + 1,
                lastFailedAuthCheck: Date.now(),
              });
            }
          } catch (error) {
            console.error('[AUTH_STORE] Session load failed:', error);
            // Network error - record failure
            set({
              failedAuthAttempts: get().failedAuthAttempts + 1,
              lastFailedAuthCheck: Date.now(),
            });
          } finally {
            // Clear loading state and promise when done
            set({ isLoading: false, _authPromise: null });
          }
        })();

        // Store promise for deduplication
        set({ _authPromise: authPromise });
        return authPromise;
      },
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => localStorage), // Use localStorage for persistence across tabs
      partialize: (state) => ({
        // Only persist non-sensitive state
        sessionStartTime: state.sessionStartTime,
        lastActivity: state.lastActivity,
        lastAuthCheck: state.lastAuthCheck,
        // Persist auth state to avoid logout on refresh
        isAuthenticated: state.isAuthenticated,
        // Persist basic user info for faster initial load
        user: state.user ? {
          id: state.user.id,
          name: state.user.name,
          email: state.user.email,
          image: state.user.image,
          emailVerified: state.user.emailVerified,
        } : null,
      }),
    }
  )
);

// Helper functions for auth store
export const authStoreHelpers = {
  // Check if session is expired due to inactivity
  // NOTE: Desktop apps with saved devices NEVER expire due to inactivity
  // They stay logged in until device token expires (90 days) or user logs out
  isSessionExpired: (): boolean => {
    // Desktop apps don't have inactivity timeout - saved devices stay logged in
    const isDesktop = typeof window !== 'undefined' && window.electron?.isDesktop;
    if (isDesktop) return false;

    const state = useAuthStore.getState();
    if (!state.lastActivity || !state.isAuthenticated) return false;

    return Date.now() - state.lastActivity > ACTIVITY_TIMEOUT;
  },

  // Check if auth data is stale and needs refresh
  needsAuthCheck: (): boolean => {
    const state = useAuthStore.getState();
    if (!state.lastAuthCheck) return true;
    
    return Date.now() - state.lastAuthCheck > AUTH_CHECK_INTERVAL;
  },

  // Get session duration in milliseconds
  getSessionDuration: (): number => {
    const state = useAuthStore.getState();
    if (!state.sessionStartTime) return 0;
    
    return Date.now() - state.sessionStartTime;
  },

  // Update activity timestamp (call on user interactions)
  trackActivity: (): void => {
    useAuthStore.getState().updateActivity();
  },

  // Check if too many failed auth attempts recently (circuit breaker)
  shouldSkipAuthCheck: (): boolean => {
    const state = useAuthStore.getState();

    // No failed attempts - allow auth check
    if (state.failedAuthAttempts === 0 || !state.lastFailedAuthCheck) {
      return false;
    }

    // Check if timeout has passed
    const timeSinceLastFailure = Date.now() - state.lastFailedAuthCheck;
    if (timeSinceLastFailure > FAILED_AUTH_TIMEOUT) {
      // Timeout passed, clear attempts and allow check
      useAuthStore.getState().clearFailedAttempts();
      return false;
    }

    // Use higher threshold for desktop (more resilient to transient network issues)
    const isDesktop = typeof window !== 'undefined' && window.electron?.isDesktop;
    const maxAttempts = isDesktop ? MAX_FAILED_AUTH_ATTEMPTS_DESKTOP : MAX_FAILED_AUTH_ATTEMPTS;

    // Too many recent failures - skip auth check
    return state.failedAuthAttempts >= maxAttempts;
  },

  // Check if auth check is needed (considering server initialization)
  shouldLoadSession: (): boolean => {
    const state = useAuthStore.getState();

    // Skip if circuit breaker is active
    if (authStoreHelpers.shouldSkipAuthCheck()) {
      return false;
    }

    // Skip if already loading
    if (state._authPromise) {
      return false;
    }

    // Always load if not hydrated yet
    if (!state.hasHydrated) {
      return true;
    }

    // If server session was initialized, only reload if stale
    if (state._serverSessionInitialized) {
      return authStoreHelpers.needsAuthCheck();
    }

    // No server data and no recent check - load session
    return !state.lastAuthCheck || authStoreHelpers.needsAuthCheck();
  },

  // Initialize store from server session (called during app startup)
  initializeFromServer: (initialUser: User | null): void => {
    useAuthStore.getState().initializeFromServer(initialUser);
  },

  // Load session with deduplication (main method for auth checks)
  loadSession: (force = false): Promise<void> => {
    return useAuthStore.getState().loadSession(force);
  },

  // Cleanup functions for event listeners (stored for proper cleanup)
  _authClearedCleanup: null as (() => void) | null,
  _authRefreshedHandler: null as (() => void) | null,
  _authExpiredHandler: null as (() => Promise<void>) | null,

  // Initialize auth event listeners (call once at app startup)
  initializeEventListeners: (): void => {
    if (typeof window === 'undefined') return;

    const handleAuthRefreshed = () => {
      // Import editing store dynamically to avoid circular dependencies
      import('@/stores/useEditingStore').then(({ useEditingStore, getEditingDebugInfo }) => {
        const editingState = useEditingStore.getState();

        // Check if any editing or streaming is active
        if (editingState.isAnyActive()) {
          const debugInfo = getEditingDebugInfo();
          console.log('[AUTH_STORE] Token refreshed during active editing/streaming', {
            sessionCount: debugInfo.sessionCount,
            isEditing: debugInfo.isAnyEditing,
            isStreaming: debugInfo.isAnyStreaming,
            sessions: debugInfo.sessions.map(s => ({
              type: s.type,
              id: s.id,
              duration: `${Math.round(s.duration / 1000)}s`,
            })),
          });

          // Store was already updated by use-token-refresh hook
          // No need to reload session - editing protection is working
          return;
        }

        console.log('[AUTH_STORE] Token refreshed successfully');

        // Store was already updated directly by use-token-refresh hook
        // SWR will revalidate endpoints naturally based on their individual configurations:
        // - Per-hook refresh intervals (15s-5min)
        // - On window focus (where enabled)
        // - On reconnect (default SWR behavior)
        // - Manual mutations after operations
        // - Socket.IO real-time updates for messages/usage
        //
        // Removed aggressive "revalidate all /api/*" logic that caused infinite loop:
        // - 80+ simultaneous requests exceeded browser connection limits
        // - ERR_INSUFFICIENT_RESOURCES → 401 errors → more refreshes → infinite loop
        // - Production apps (Notion, Google Docs) don't revalidate all endpoints after token refresh
      });
    };

    const handleAuthExpired = async () => {
      console.log('[AUTH_STORE] Token expired - logging out');

      if (typeof window !== 'undefined' && window.electron?.isDesktop) {
        try {
          await window.electron.auth.clearAuth();
        } catch (error) {
          console.error('[AUTH_STORE] Failed to clear desktop auth session on expiry', error);
        }

        try {
          const { clearJWTCache } = await import('@/lib/auth/auth-fetch');
          clearJWTCache();
        } catch (error) {
          console.error('[AUTH_STORE] Failed to clear JWT cache on expiry', error);
        }
      }

      // Token expired and couldn't be refreshed, clear session
      const state = useAuthStore.getState();
      state.endSession();

      // Redirect to login page
      if (typeof window !== 'undefined') {
        window.location.href = '/auth/signin';
      }
    };

    const handleAuthCleared = () => {
      console.log('[AUTH_STORE] Desktop auth cleared event received');
      // Clear user state to force signin screen
      const state = useAuthStore.getState();
      state.endSession();
    };

    // Remove existing listeners using stored references to prevent duplicates
    if (authStoreHelpers._authRefreshedHandler) {
      window.removeEventListener('auth:refreshed', authStoreHelpers._authRefreshedHandler);
    }
    if (authStoreHelpers._authExpiredHandler) {
      window.removeEventListener('auth:expired', authStoreHelpers._authExpiredHandler);
    }

    // Store new handler references for future cleanup
    authStoreHelpers._authRefreshedHandler = handleAuthRefreshed;
    authStoreHelpers._authExpiredHandler = handleAuthExpired;

    // Add new listeners
    window.addEventListener('auth:refreshed', handleAuthRefreshed);
    window.addEventListener('auth:expired', handleAuthExpired);

    // Desktop-specific: Listen for IPC auth cleared event
    // CRITICAL: Clean up previous listener to prevent memory leak
    if (typeof window !== 'undefined' && window.electron) {
      // Clean up previous IPC listener if it exists
      if (authStoreHelpers._authClearedCleanup) {
        authStoreHelpers._authClearedCleanup();
        authStoreHelpers._authClearedCleanup = null;
      }

      // Add new listener and store cleanup function
      const cleanup = window.electron.on?.('auth:cleared', handleAuthCleared);
      if (cleanup) {
        authStoreHelpers._authClearedCleanup = cleanup;
      }
    }
  },
};