'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface User {
  id: string;
  name: string | null;
  email: string | null;
  image?: string | null;
  emailVerified?: Date | null;
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
const AUTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes (less frequent)
const ACTIVITY_UPDATE_THROTTLE = 5 * 1000; // Only update activity every 5 seconds
const MAX_FAILED_AUTH_ATTEMPTS = 3; // Max failed attempts before circuit breaker
const FAILED_AUTH_TIMEOUT = 30 * 1000; // 30 seconds timeout for failed attempts

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
        
        set({
          user: null,
          isAuthenticated: false,
          sessionStartTime: null,
          lastActivity: null,
          refreshTimeoutId: null,
          isRefreshing: false,
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
          console.log('[AUTH_STORE] Skipping auth check - circuit breaker active');
          return;
        }

        // Set loading state to prevent premature redirects (critical for OAuth flow)
        set({ isLoading: true });

        // Create new auth promise
        const authPromise = (async () => {
          try {
            const response = await fetch('/api/auth/me', {
              credentials: 'include',
            });

            if (response.ok) {
              const userData = await response.json();
              set({
                user: userData,
                isAuthenticated: true,
                lastAuthCheck: Date.now(),
                failedAuthAttempts: 0,
                lastFailedAuthCheck: null,
              });
              // Update activity for new session
              get().updateActivity();
            } else if (response.status === 401) {
              // Unauthorized - clear user and record failure
              set({
                user: null,
                isAuthenticated: false,
                failedAuthAttempts: state.failedAuthAttempts + 1,
                lastFailedAuthCheck: Date.now(),
              });
            } else {
              // Other errors - record failure but don't clear user
              set({
                failedAuthAttempts: state.failedAuthAttempts + 1,
                lastFailedAuthCheck: Date.now(),
              });
            }
          } catch (error) {
            console.error('[AUTH_STORE] Session load failed:', error);
            // Network error - record failure
            set({
              failedAuthAttempts: state.failedAuthAttempts + 1,
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
  isSessionExpired: (): boolean => {
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

    // Too many recent failures - skip auth check
    return state.failedAuthAttempts >= MAX_FAILED_AUTH_ATTEMPTS;
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

  // Initialize auth event listeners (call once at app startup)
  initializeEventListeners: (): void => {
    if (typeof window === 'undefined') return;

    const handleAuthRefreshed = () => {
      console.log('[AUTH_STORE] Token refreshed - updating session');
      // Token was refreshed successfully, update auth state silently
      authStoreHelpers.loadSession();
    };

    const handleAuthExpired = async () => {
      console.log('[AUTH_STORE] Token expired - logging out');
      // Token expired and couldn't be refreshed, clear session
      const state = useAuthStore.getState();
      state.endSession();

      // Redirect to login page
      if (typeof window !== 'undefined') {
        window.location.href = '/auth/signin';
      }
    };

    // Remove existing listeners to prevent duplicates
    window.removeEventListener('auth:refreshed', handleAuthRefreshed);
    window.removeEventListener('auth:expired', handleAuthExpired);

    // Add new listeners
    window.addEventListener('auth:refreshed', handleAuthRefreshed);
    window.addEventListener('auth:expired', handleAuthExpired);
  },
};