'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface User {
  id: string;
  name: string | null;
  email: string | null;
  image?: string | null;
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
        });
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
};