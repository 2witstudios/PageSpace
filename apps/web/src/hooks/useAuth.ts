'use client';

import { useEffect, useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore, authStoreHelpers } from '@/stores/useAuthStore';
import { useTokenRefresh } from './useTokenRefresh';
import { post, clearJWTCache } from '@/lib/auth/auth-fetch';
import { getOrCreateDeviceId, getDeviceName } from '@/lib/analytics';
import { z } from 'zod/v4';

// Schema for validating desktop OAuth tokens from URL
const desktopOAuthTokensSchema = z.object({
  token: z.string().min(1, "Access token is required"),
  refreshToken: z.string().min(1, "Refresh token is required"),
  csrfToken: z.string(),
  deviceToken: z.string(),
});

interface User {
  id: string;
  name: string | null;
  email: string | null;
  image?: string | null;
  role?: 'user' | 'admin';
}

interface AuthActions {
  login: (
    email: string,
    password: string
  ) => Promise<{ success: boolean; error?: string; redirectTo?: string }>;
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
      // Fetch login CSRF token first (prevents Login CSRF attacks)
      let loginCsrfToken: string | null = null;
      try {
        const csrfResponse = await fetch('/api/auth/login-csrf', {
          credentials: 'include',
        });
        if (csrfResponse.ok) {
          const csrfData = await csrfResponse.json();
          loginCsrfToken = csrfData.csrfToken;
        }
      } catch (csrfError) {
        console.error('Failed to fetch login CSRF token:', csrfError);
        // Continue without CSRF token - server will reject if required
      }

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

          // CRITICAL FIX: Verify token is actually retrievable before proceeding
          // This prevents race condition where loadSession is triggered before storage completes
          const storedJWT = await window.electron.auth.getJWT();
          if (!storedJWT) {
            console.error('[Desktop Login] Token storage verification failed');
            return {
              success: false,
              error: 'Failed to save login session. Please try again.'
            };
          }

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
        headers: {
          'Content-Type': 'application/json',
          ...(loginCsrfToken && { 'X-Login-CSRF-Token': loginCsrfToken }),
        },
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
        const redirectTo =
          typeof userData.redirectTo === 'string' ? userData.redirectTo : undefined;
        return { success: true, ...(redirectTo && { redirectTo }) };
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

  // Track OAuth token storage in progress to prevent race condition
  const [isStoringOAuthTokens, setIsStoringOAuthTokens] = useState(false);

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

  // DESKTOP OAUTH: Handle tokens passed through URL from OAuth callback
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.electron?.isDesktop) return;

    const params = new URLSearchParams(window.location.search);
    const isDesktopOAuth = params.get('desktop') === 'true';
    const tokensParam = params.get('tokens');

    if (isDesktopOAuth && tokensParam) {
      console.log('[AUTH_HOOK] Desktop OAuth tokens detected, storing in Electron...');

      // Mark storage in progress
      setIsStoringOAuthTokens(true);

      (async () => {
        try {
          // Decode tokens from URL (using browser-native atob)
          const decodedData = JSON.parse(atob(tokensParam));

          // Validate token structure with Zod
          const tokensData = desktopOAuthTokensSchema.parse(decodedData);

          // Store in Electron encrypted storage
          if (!window.electron) {
            console.error('[AUTH_HOOK] Electron API not available');
            return;
          }
          await window.electron.auth.storeSession({
            accessToken: tokensData.token,
            refreshToken: tokensData.refreshToken,
            csrfToken: tokensData.csrfToken,
            deviceToken: tokensData.deviceToken,
          });

          // Store device token in localStorage
          if (tokensData.deviceToken) {
            localStorage.setItem('deviceToken', tokensData.deviceToken);
          }

          clearJWTCache();

          // Verify token is retrievable
          const storedJWT = await window.electron.auth.getJWT();
          if (!storedJWT) {
            console.error('[AUTH_HOOK] Desktop OAuth token storage verification failed');
            return;
          }

          console.log('[AUTH_HOOK] Desktop OAuth tokens stored successfully');

          // Clean up URL
          params.delete('desktop');
          params.delete('tokens');
          const newUrl = new URL(window.location.href);
          newUrl.search = params.toString();
          window.history.replaceState({}, '', newUrl.toString());

          // Trigger auth state refresh
          setIsOAuthSuccess(true);
        } catch (error) {
          if (error instanceof z.ZodError) {
            console.error('[AUTH_HOOK] Invalid OAuth token structure:', error.issues);
          } else {
            console.error('[AUTH_HOOK] Failed to store desktop OAuth tokens:', error);
          }

          // Redirect to signin with error
          window.location.href = '/auth/signin?error=oauth_error';
        } finally {
          // Mark storage complete (success or failure)
          setIsStoringOAuthTokens(false);
        }
      })();
    }
  }, []);

  // Initial auth check - simplified with store-level deduplication
  useEffect(() => {
    // Wait for hydration
    if (!hasHydrated) return;

    // Wait for OAuth token storage to complete
    if (isStoringOAuthTokens) {
      console.log('[AUTH_HOOK] Waiting for OAuth token storage to complete...');
      return;
    }

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
  }, [hasHydrated, isOAuthSuccess, isStoringOAuthTokens]);

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
    isLoading: isLoading || !hasHydrated || isOAuthSuccess || isStoringOAuthTokens, // Block rendering during OAuth token storage
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
