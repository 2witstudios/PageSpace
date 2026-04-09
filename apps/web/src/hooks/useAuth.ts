'use client';

import { useEffect, useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore, authStoreHelpers } from '@/stores/useAuthStore';
import { useTokenRefresh } from './useTokenRefresh';
import { post, clearSessionCache } from '@/lib/auth/auth-fetch';
import { getOrCreateDeviceId, getDeviceName } from '@/lib/analytics';

// Module-level flag to prevent concurrent lazy device registration attempts
let deviceRegistrationInFlight = false;

interface User {
  id: string;
  name: string | null;
  email: string | null;
  image?: string | null;
  role?: 'user' | 'admin';
}

interface AuthActions {
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
  const { setHydrated, endSession } = useAuthStore.getState();

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
        clearSessionCache();
      }

      // iOS: Clear session from Keychain
      if (typeof window !== 'undefined') {
        const { isCapacitorApp, getPlatform } = await import('@/lib/capacitor-bridge');
        if (isCapacitorApp() && getPlatform() === 'ios') {
          try {
            const { clearStoredSession } = await import('@/lib/ios-google-auth');
            await clearStoredSession();
          } catch (err) {
            console.error('Failed to clear iOS Keychain session', err);
          }
        }
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

      // Clear persisted tab state so desktop startup doesn't restore stale/inaccessible routes.
      // Reset to a single /dashboard tab — closeAllTabs() preserves pinned tabs by design,
      // but logout must fully clear session-specific state including pinned tabs.
      try {
        const { useTabsStore } = await import('@/stores/useTabsStore');
        useTabsStore.setState({ tabs: [], activeTabId: null });
      } catch {
        // Non-critical — tabs will just show dashboard on next login
      }

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
    // Only start token refresh if we have a user AND are authenticated AND hydrated
    if (isAuthenticated && user && hasHydrated) {
      // Only start if not already active to prevent spam
      if (!tokenRefreshActiveRef.current) {
        tokenRefreshActiveRef.current = true;
        startTokenRefresh();
      }
    } else if (!isAuthenticated || !user) {
      // Stop token refresh when not authenticated
      if (tokenRefreshActiveRef.current) {
        tokenRefreshActiveRef.current = false;
        stopTokenRefresh();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user?.id, hasHydrated, startTokenRefresh, stopTokenRefresh]); // user intentionally omitted - only depends on ID for stability

  // Set hydrated state when component mounts
  useEffect(() => {
    if (!hasHydrated) {
      setHydrated(true);
    }
  }, [hasHydrated, setHydrated]);

  // Check for OAuth success parameter (from Google callback)
  // Desktop OAuth now uses secure exchange codes handled in Electron main process
  const [isOAuthSuccess, setIsOAuthSuccess] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('auth') === 'success';
  });

  // Capture device token from cookie (set by OAuth/signup redirect) and persist to localStorage
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const match = document.cookie.match(/(?:^|;\s*)ps_device_token=([^;]+)/);
    if (match?.[1]) {
      localStorage.setItem('deviceToken', match[1]);
      // Clear the short-lived cookie
      document.cookie = 'ps_device_token=; Path=/; Max-Age=0';
    }
  }, []);

  // Lazy device registration: if authenticated but no device token (e.g., magic link login),
  // register the device to enable session recovery when the cookie expires.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
    if (!isAuthenticated || !hasHydrated) return;
    if (window.electron?.isDesktop) return;
    if (deviceRegistrationInFlight) return;

    const existingToken = localStorage.getItem('deviceToken');
    if (existingToken) return;

    deviceRegistrationInFlight = true;

    const registerDevice = async () => {
      try {
        // Skip for Capacitor apps — they handle device tokens via platform-specific mechanisms
        const { isCapacitorApp } = await import('@/lib/capacitor-bridge');
        if (isCapacitorApp()) return;

        const deviceId = getOrCreateDeviceId();
        const deviceName = getDeviceName();

        const data = await post<{ deviceToken?: string }>('/api/auth/device/register', { deviceId, deviceName });
        if (data?.deviceToken) {
          localStorage.setItem('deviceToken', data.deviceToken);
          console.log('[AUTH_HOOK] Device registered via lazy registration');
        }
      } catch (error) {
        console.warn('[AUTH_HOOK] Lazy device registration failed:', error);
      } finally {
        deviceRegistrationInFlight = false;
      }
    };

    void registerDevice();
  }, [isAuthenticated, hasHydrated]);

  // Initial auth check - simplified with store-level deduplication
  // Desktop OAuth now uses secure exchange codes handled in Electron main process
  useEffect(() => {
    // Wait for hydration
    if (!hasHydrated) return;

    // Use store helper to determine if session load is needed
    const shouldLoad = authStoreHelpers.shouldLoadSession() || isOAuthSuccess;

    if (shouldLoad) {
      console.log(`[AUTH_HOOK] Loading session - hasHydrated: ${hasHydrated}, isOAuthSuccess: ${isOAuthSuccess}`);

      // Await loadSession to ensure isLoading is set before clearing OAuth flag
      const loadAndCleanup = async () => {
        try {
          await authStoreHelpers.loadSession(isOAuthSuccess); // Force reload for OAuth success
        } catch (error) {
          console.error('[AUTH_HOOK] Failed to load session during initial auth check:', error);
        } finally {
          // Clean up OAuth success parameter from URL after session loads
          if (isOAuthSuccess && typeof window !== 'undefined') {
            console.log('[AUTH_HOOK] Cleaning up OAuth success parameter from URL');
            const newUrl = new URL(window.location.href);
            newUrl.searchParams.delete('auth');
            window.history.replaceState({}, '', newUrl.toString());
            setIsOAuthSuccess(false); // Clear the flag to exit loading state
          }
        }
      };
      void loadAndCleanup();
    } else {
      // Multiple components can mount useAuth simultaneously.
      // If another instance already started loadSession(), keep loading true
      // until that shared auth promise settles.
      const hasInFlightSessionLoad = !!useAuthStore.getState()._authPromise;
      if (hasInFlightSessionLoad) return;

      // Session check not needed (e.g., lastAuthCheck is recent) — unblock the UI
      useAuthStore.getState().setLoading(false);
    }
  }, [hasHydrated, isOAuthSuccess]);

  // Initialize auth event listeners once (moved to store level for deduplication)
  useEffect(() => {
    // Only initialize event listeners once across all hook instances
    // This prevents duplicate event listeners when multiple components use useAuth
    authStoreHelpers.initializeEventListeners();
  }, []); // Empty dependency array ensures this runs only once

  return {
    user,
    isLoading: isLoading || !hasHydrated || isOAuthSuccess,
    isAuthenticated,
    isRefreshing,
    sessionDuration: authStoreHelpers.getSessionDuration(),
    actions: {
      logout,
      refreshAuth,
      checkAuth,
    },
    // Legacy properties for backward compatibility
    isError: !isAuthenticated && !isLoading && hasHydrated ? new Error('Not authenticated') : undefined,
    mutate: checkAuth,
  };
}
