'use client';

import { useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore, authStoreHelpers } from '@/stores/auth-store';
import { useTokenRefresh } from './use-token-refresh';

interface User {
  id: string;
  name: string | null;
  email: string | null;
  image?: string | null;
}

interface AuthActions {
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export function useAuth(): {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isRefreshing: boolean;
  sessionDuration: number;
  actions: AuthActions;
  // Legacy properties for backward compatibility
  isError?: Error | undefined;
  mutate?: () => void;
} {
  const {
    user,
    isLoading,
    isAuthenticated,
    isRefreshing,
    hasHydrated,
    setUser,
    setLoading,
    setHydrated,
    startSession,
    endSession,
    updateActivity,
    recordFailedAuth,
    clearFailedAttempts,
  } = useAuthStore();

  const { refreshToken, startTokenRefresh, stopTokenRefresh } = useTokenRefresh();
  const router = useRouter();
  const tokenRefreshActiveRef = useRef(false);

  // Helper function to check if we should attempt auth check
  // Note: HttpOnly cookies aren't visible to document.cookie, so we'll always attempt auth check
  const shouldAttemptAuthCheck = useCallback(() => {
    return typeof document !== 'undefined';
  }, []);

  // Silent auth check - doesn't trigger loading states (used for background token refresh)
  const silentCheckAuth = useCallback(async () => {
    // Circuit breaker - skip if too many recent failures
    if (authStoreHelpers.shouldSkipAuthCheck()) {
      console.log('[AUTH_HOOK] Skipping silent auth check - too many recent failures (circuit breaker)');
      return;
    }

    console.log('[AUTH_HOOK] Starting silent auth check (no loading state)');
    
    try {
      const response = await fetch('/api/auth/me', {
        credentials: 'include',
      });

      console.log(`[AUTH_HOOK] Silent auth response status: ${response.status}`);

      if (response.ok) {
        const userData = await response.json();
        console.log(`[AUTH_HOOK] Silent auth - User data received: ${userData.email} (id: ${userData.id})`);
        setUser(userData);
        updateActivity();
        // Clear any failed attempts on success
        clearFailedAttempts();
      } else if (response.status === 401) {
        console.log('[AUTH_HOOK] Silent auth - 401 Unauthorized - clearing user and recording failed attempt');
        // Record failed attempt and clear user on 401 (unauthorized)
        recordFailedAuth();
        setUser(null);
      } else {
        console.log(`[AUTH_HOOK] Silent auth - Other error ${response.status} - not clearing user state`);
        // For other errors (network, server), don't clear user state
      }
    } catch (error) {
      console.error('💥 Silent auth check failed with error:', error);
      // Record failed attempt on network errors
      recordFailedAuth();
      // Only clear user on network errors if we don't have a user yet
      if (!user) {
        console.log('[AUTH_HOOK] Silent auth - Network error with no user - clearing state');
        setUser(null);
      }
    }
    console.log('[AUTH_HOOK] Silent auth check completed');
  }, [setUser, updateActivity, user, recordFailedAuth, clearFailedAttempts]);

  // Check authentication status (with loading state for user-initiated checks)
  const checkAuth = useCallback(async () => {
    if (isLoading) {
      console.log('[AUTH_HOOK] Skipping auth check - already loading');
      return;
    }

    // Circuit breaker - skip if too many recent failures
    if (authStoreHelpers.shouldSkipAuthCheck()) {
      console.log('[AUTH_HOOK] Skipping auth check - too many recent failures (circuit breaker)');
      return;
    }

    console.log('[AUTH_HOOK] Starting auth check');
    setLoading(true);
    
    try {
      const response = await fetch('/api/auth/me', {
        credentials: 'include',
      });

      console.log(`[AUTH_HOOK] Auth response status: ${response.status}`);

      if (response.ok) {
        const userData = await response.json();
        console.log(`[AUTH_HOOK] User data received: ${userData.email} (id: ${userData.id})`);
        setUser(userData);
        updateActivity();
        // Clear any failed attempts on success
        clearFailedAttempts();
      } else if (response.status === 401) {
        console.log('[AUTH_HOOK] 401 Unauthorized - clearing user and recording failed attempt');
        // Record failed attempt and clear user on 401 (unauthorized)
        recordFailedAuth();
        setUser(null);
      } else {
        console.log(`[AUTH_HOOK] Other error ${response.status} - not clearing user state`);
        // For other errors (network, server), don't clear user state
      }
    } catch (error) {
      console.error('💥 Auth check failed with error:', error);
      // Record failed attempt on network errors
      recordFailedAuth();
      // Only clear user on network errors if we don't have a user yet
      if (!user) {
        console.log('[AUTH_HOOK] Network error with no user - clearing state');
        setUser(null);
      }
    } finally {
      setLoading(false);
      console.log('[AUTH_HOOK] Auth check completed');
    }
  }, [isLoading, setUser, setLoading, updateActivity, user, recordFailedAuth, clearFailedAttempts]);

  // Login function
  const login = useCallback(async (email: string, password: string) => {
    setLoading(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'include',
      });

      if (response.ok) {
        const userData = await response.json();
        setUser(userData);
        startSession();
        return { success: true };
      } else {
        const errorData = await response.json();
        return { 
          success: false, 
          error: errorData.error || 'Login failed' 
        };
      }
    } catch (error) {
      console.error('Login error:', error);
      return { 
        success: false, 
        error: 'Network error. Please try again.' 
      };
    } finally {
      setLoading(false);
    }
  }, [setUser, setLoading, startSession]);

  // Logout function
  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      // Reset token refresh state
      tokenRefreshActiveRef.current = false;
      endSession();
      router.push('/auth/signin');
    }
  }, [endSession, router]);

  // Refresh authentication
  const refreshAuth = useCallback(async () => {
    const success = await refreshToken();
    if (success) {
      await checkAuth();
    } else {
      await logout();
    }
  }, [refreshToken, checkAuth, logout]);


  // Session management and token refresh startup
  useEffect(() => {
    let activityCheckInterval: NodeJS.Timeout;

    // Only start token refresh if we have a user AND are authenticated AND hydrated
    if (isAuthenticated && user && hasHydrated) {
      // Only start if not already active to prevent spam
      if (!tokenRefreshActiveRef.current) {
        tokenRefreshActiveRef.current = true;
        startTokenRefresh();
      }
      
      // Check for session expiry every 5 minutes (more forgiving)
      activityCheckInterval = setInterval(() => {
        if (authStoreHelpers.isSessionExpired()) {
          logout();
        }
      }, 5 * 60 * 1000);
    } else if (!isAuthenticated || !user) {
      // Stop token refresh when not authenticated
      if (tokenRefreshActiveRef.current) {
        tokenRefreshActiveRef.current = false;
        stopTokenRefresh();
      }
    }

    return () => {
      if (activityCheckInterval) clearInterval(activityCheckInterval);
    };
  }, [isAuthenticated, user, hasHydrated, logout, startTokenRefresh, stopTokenRefresh]);

  // Set hydrated state when component mounts
  useEffect(() => {
    if (!hasHydrated) {
      setHydrated(true);
    }
  }, [hasHydrated, setHydrated]);

  // Initial auth check - only run after hydration
  useEffect(() => {
    const canAttemptAuth = shouldAttemptAuthCheck();
    
    // Check for OAuth success parameter (from Google callback)
    const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const isOAuthSuccess = urlParams?.get('auth') === 'success';
    
    if (isOAuthSuccess) {
      console.log('[AUTH_HOOK] OAuth success parameter detected - will force auth check');
    }
    
    // Circuit breaker check - skip if too many failed attempts
    const shouldSkipDueToFailures = authStoreHelpers.shouldSkipAuthCheck();
    
    const shouldCheckAuth = hasHydrated && !shouldSkipDueToFailures && (
      // Case 1: We have persisted user data but need to validate (stale check)
      (user && authStoreHelpers.needsAuthCheck()) ||
      // Case 2: No user data but we're hydrated (attempt auth check for HttpOnly cookies)
      // CRITICAL FIX: Only check if we haven't had a recent auth check
      (!user && canAttemptAuth && authStoreHelpers.needsAuthCheck()) ||
      // Case 3: OAuth success - force auth check regardless
      isOAuthSuccess
    );

    if (shouldCheckAuth) {
      console.log(`[AUTH_HOOK] Auth check triggered - hasHydrated: ${hasHydrated}, user: ${!!user}, isOAuthSuccess: ${isOAuthSuccess}, shouldSkipDueToFailures: ${shouldSkipDueToFailures}`);
      checkAuth();
      
      // Clean up OAuth success parameter from URL after auth check
      if (isOAuthSuccess && typeof window !== 'undefined') {
        console.log('[AUTH_HOOK] Cleaning up OAuth success parameter from URL');
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.delete('auth');
        window.history.replaceState({}, '', newUrl.toString());
      }
    }
  }, [hasHydrated, user, shouldAttemptAuthCheck, checkAuth]);

  // Listen for auth events from the fetch wrapper
  useEffect(() => {
    const handleAuthRefreshed = () => {
      // Token was refreshed successfully, update auth state silently (no loading state)
      // This prevents UI disruption during automatic token refreshes
      silentCheckAuth();
    };

    const handleAuthExpired = () => {
      // Token expired and couldn't be refreshed, logout
      logout();
    };

    window.addEventListener('auth:refreshed', handleAuthRefreshed);
    window.addEventListener('auth:expired', handleAuthExpired);

    return () => {
      window.removeEventListener('auth:refreshed', handleAuthRefreshed);
      window.removeEventListener('auth:expired', handleAuthExpired);
    };
  }, [silentCheckAuth, logout]);

  // Track user activity
  useEffect(() => {
    if (!isAuthenticated) return;

    const trackActivity = () => {
      updateActivity();
    };

    // Track various user activities
    const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
    
    events.forEach(event => {
      document.addEventListener(event, trackActivity, true);
    });

    return () => {
      events.forEach(event => {
        document.removeEventListener(event, trackActivity, true);
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]); // updateActivity intentionally omitted to prevent infinite loop

  return {
    user,
    isLoading: isLoading || !hasHydrated,
    isAuthenticated,
    isRefreshing,
    sessionDuration: authStoreHelpers.getSessionDuration(),
    actions: {
      login,
      logout,
      refreshAuth,
      checkAuth,
    },
    // Legacy properties for backward compatibility
    isError: !isAuthenticated && !isLoading && hasHydrated ? new Error('Not authenticated') : undefined,
    mutate: checkAuth,
  };
}