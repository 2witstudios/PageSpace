'use client';

import { useEffect, useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore, authStoreHelpers } from '@/stores/auth-store';
import { useTokenRefresh } from './use-token-refresh';
import { post, clearJWTCache } from '@/lib/auth-fetch';
import { getOrCreateDeviceId, getDeviceName } from '@/lib/device-fingerprint';

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
  // Use individual selectors to prevent unnecessary re-renders
  // Each component only subscribes to the specific state properties it uses
  const user = useAuthStore(state => state.user);
  const isLoading = useAuthStore(state => state.isLoading);
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const isRefreshing = useAuthStore(state => state.isRefreshing);
  const hasHydrated = useAuthStore(state => state.hasHydrated);

  // Access stable methods without subscribing (they don't change)
  const { setUser, setLoading, setHydrated, startSession, endSession, updateActivity } = useAuthStore.getState();

  const { refreshToken, startTokenRefresh, stopTokenRefresh } = useTokenRefresh();
  const router = useRouter();
  const tokenRefreshActiveRef = useRef(false);


  // Check authentication status - delegates to store method (maintains backward compatibility)
  const checkAuth = useCallback(async () => {
    if (isLoading) {
      console.log('[AUTH_HOOK] Skipping auth check - already loading');
      return;
    }

    // Use store's deduplicated loadSession method (store handles loading state)
    await authStoreHelpers.loadSession();
  }, [isLoading]);

  // Login function
  const login = useCallback(async (email: string, password: string) => {
    setLoading(true);
    try {
      const isDesktop = typeof window !== 'undefined' && window.electron?.isDesktop;

      if (isDesktop && window.electron) {
        const [deviceInfo, existingSession] = await Promise.all([
          window.electron.auth.getDeviceInfo(),
          window.electron.auth.getSession(),
        ]);

        const desktopLoginPayload: {
          email: string;
          password: string;
          deviceId: string;
          platform: 'desktop';
          deviceName: string;
          appVersion: string;
          deviceToken?: string;
        } = {
          email,
          password,
          deviceId: deviceInfo.deviceId,
          platform: 'desktop',
          deviceName: deviceInfo.deviceName,
          appVersion: deviceInfo.appVersion,
        };

        if (existingSession?.deviceToken) {
          desktopLoginPayload.deviceToken = existingSession.deviceToken;
        }

        const response = await fetch('/api/auth/mobile/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(desktopLoginPayload),
        });

        if (response.ok) {
          const userData = await response.json();

          await window.electron.auth.storeSession({
            accessToken: userData.token,
            refreshToken: userData.refreshToken,
            csrfToken: userData.csrfToken,
            deviceToken: userData.deviceToken,
          });

          clearJWTCache();
          setUser(userData.user);
          startSession();
          return { success: true };
        }

        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: errorData.error || 'Login failed',
        };
      }

      // Get device information for device token creation
      const deviceId = getOrCreateDeviceId();
      const deviceName = getDeviceName();
      const existingDeviceToken = typeof localStorage !== 'undefined' ? localStorage.getItem('deviceToken') : null;

      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          deviceId,
          deviceName,
          ...(existingDeviceToken && { deviceToken: existingDeviceToken }),
        }),
        credentials: 'include',
      });

      if (response.ok) {
        const userData = await response.json();

        // Store device token if returned
        if (userData.deviceToken && typeof localStorage !== 'undefined') {
          localStorage.setItem('deviceToken', userData.deviceToken);
        }

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
      await post('/api/auth/logout');
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      if (typeof window !== 'undefined' && window.electron?.isDesktop) {
        try {
          await window.electron.auth.clearAuth();
        } catch (err) {
          console.error('Failed to clear desktop auth session', err);
        }
        clearJWTCache();
      }

      // Clear device token from localStorage (web platform)
      if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        try {
          localStorage.removeItem('deviceToken');
        } catch (err) {
          console.error('Failed to clear device token from localStorage', err);
        }
      }

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
      // Force reload session after token refresh
      await authStoreHelpers.loadSession(true);
    } else {
      await logout();
    }
  }, [refreshToken, logout]);


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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user?.id, hasHydrated, logout, startTokenRefresh, stopTokenRefresh]); // user intentionally omitted - only depends on ID for stability

  // Set hydrated state when component mounts
  useEffect(() => {
    if (!hasHydrated) {
      setHydrated(true);
    }
  }, [hasHydrated, setHydrated]);

  // Check for OAuth success parameter (from Google callback) and device token
  const [isOAuthSuccess, setIsOAuthSuccess] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('auth') === 'success';
  });

  // Capture device token from URL (signup redirect) and store in localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    const deviceTokenParam = params.get('deviceToken');

    if (deviceTokenParam) {
      localStorage.setItem('deviceToken', deviceTokenParam);
      // Clean up URL
      params.delete('deviceToken');
      const newUrl = new URL(window.location.href);
      newUrl.search = params.toString();
      window.history.replaceState({}, '', newUrl.toString());
    }
  }, []);

  // Initial auth check - simplified with store-level deduplication
  useEffect(() => {
    if (!hasHydrated) return;

    // Use store helper to determine if session load is needed
    const shouldLoad = authStoreHelpers.shouldLoadSession() || isOAuthSuccess;

    if (shouldLoad) {
      console.log(`[AUTH_HOOK] Loading session - hasHydrated: ${hasHydrated}, isOAuthSuccess: ${isOAuthSuccess}`);

      // Use store's deduplicated loadSession
      authStoreHelpers.loadSession(isOAuthSuccess); // Force reload for OAuth success

      // Clean up OAuth success parameter from URL after auth check
      if (isOAuthSuccess && typeof window !== 'undefined') {
        console.log('[AUTH_HOOK] Cleaning up OAuth success parameter from URL');
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.delete('auth');
        window.history.replaceState({}, '', newUrl.toString());
        setIsOAuthSuccess(false); // Clear the flag to exit loading state
      }
    }
  }, [hasHydrated, isOAuthSuccess]);

  // Initialize auth event listeners once (moved to store level for deduplication)
  useEffect(() => {
    // Only initialize event listeners once across all hook instances
    // This prevents duplicate event listeners when multiple components use useAuth
    authStoreHelpers.initializeEventListeners();
  }, []); // Empty dependency array ensures this runs only once

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
    isLoading: isLoading || !hasHydrated || isOAuthSuccess, // Treat OAuth callback as loading to prevent premature redirect
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