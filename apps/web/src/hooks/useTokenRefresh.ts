'use client';

import { useEffect, useRef, useState } from 'react';
import { mutate } from 'swr';
import { useRouter } from 'next/navigation';
import { post, fetchWithAuth, refreshAuthSession, clearJWTCache } from '@/lib/auth/auth-fetch';

interface TokenRefreshOptions {
  refreshBeforeExpiryMs?: number; // How long before expiry to refresh (default: 2 minutes)
  retryAttempts?: number; // Number of retry attempts (default: 3)
  retryDelayMs?: number; // Delay between retries (default: 1000ms)
}

// Global refresh promise to prevent concurrent refresh attempts across all instances
let globalRefreshPromise: Promise<boolean> | null = null;

// Global timeout for scheduled refresh - singleton pattern to prevent multiple schedules
let globalRefreshTimeout: NodeJS.Timeout | null = null;
let isRefreshScheduled = false;

export function useTokenRefresh(options: TokenRefreshOptions = {}) {
  const {
    refreshBeforeExpiryMs = 3 * 60 * 1000, // 3 minutes (more buffer)
    retryAttempts = 5, // More retries for better network resilience
    retryDelayMs = 1000 // Base delay (will use exponential backoff)
  } = options;

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryCountRef = useRef(0);
  const lastRefreshTimeRef = useRef<number>(Date.now());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const router = useRouter();

  const clearRefreshTimeout = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  const logout = async () => {
    try {
      await post('/api/auth/logout');
      await mutate('/api/auth/me', null, false);
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      if (typeof window !== 'undefined' && window.electron?.isDesktop) {
        try {
          await window.electron.auth.clearAuth();
        } catch (error) {
          console.error('Desktop logout: failed to clear secure session', error);
        }
        clearJWTCache();
      }
      router.push('/auth/signin');
    }
  };

  const refreshToken = async (): Promise<boolean> => {
    // If there's already a refresh in progress globally, wait for it
    if (globalRefreshPromise) {
      console.log('Token refresh already in progress, waiting...');
      const result = await globalRefreshPromise;
      setIsRefreshing(false);
      return result;
    }

    // Create a new refresh promise
    globalRefreshPromise = (async () => {
      try {
        setIsRefreshing(true);
        const { success, shouldLogout } = await refreshAuthSession();

        if (success) {
          // Token refreshed successfully, fetch fresh user data
          try {
            const userResponse = await fetchWithAuth('/api/auth/me');

            if (userResponse.ok) {
              const userData = await userResponse.json();

              // Update Zustand store directly (avoid orphaned SWR mutate)
              const { useAuthStore } = await import('@/stores/useAuthStore');
              const authStore = useAuthStore.getState();
              authStore.setUser(userData);
              authStore.clearFailedAttempts();
            }
          } catch (error) {
            console.error('Failed to update user data after token refresh:', error);
          }

          retryCountRef.current = 0;
          lastRefreshTimeRef.current = Date.now(); // Track last successful refresh

          // Dispatch custom event for editing protection check
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('auth:refreshed'));
          }

          return true;
        }

        if (shouldLogout) {
          console.log('Refresh token expired or revoked, logging out');

          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('auth:expired'));
          }

          await logout();
          return false;
        }

        // Retryable failure (network/server)
        return false;
      } catch (error) {
        console.error('Token refresh error:', error);
        return false;
      } finally {
        setIsRefreshing(false);
        globalRefreshPromise = null;
      }
    })();

    return globalRefreshPromise;
  };

  const scheduleTokenRefresh = () => {
    // Clear local timeout ref
    clearRefreshTimeout();

    // Singleton pattern: Only allow one global schedule
    if (isRefreshScheduled) {
      console.log('⏰ Token refresh already scheduled globally, skipping duplicate');
      return;
    }

    isRefreshScheduled = true;

    // Access tokens expire in 15 minutes, so refresh before that
    const refreshInMs = (15 * 60 * 1000) - refreshBeforeExpiryMs; // Now 12 minutes

    console.log(`⏰ Scheduling token refresh in ${Math.round(refreshInMs / 1000 / 60)} minutes`);

    // Use global timeout instead of local ref
    globalRefreshTimeout = setTimeout(async () => {
      console.log('🔄 Executing scheduled token refresh');
      isRefreshScheduled = false; // Allow next schedule

      const success = await refreshToken();

      if (success) {
        // Schedule the next refresh
        console.log('✅ Token refresh successful, scheduling next refresh');
        scheduleTokenRefresh();
      } else {
        // Retry logic with exponential backoff
        if (retryCountRef.current < retryAttempts) {
          retryCountRef.current++;
          // Exponential backoff: 1s, 2s, 4s, 8s, 16s
          const backoffDelay = retryDelayMs * Math.pow(2, retryCountRef.current - 1);
          console.log(`❌ Token refresh failed, retrying in ${backoffDelay}ms (attempt ${retryCountRef.current}/${retryAttempts})`);

          setTimeout(() => {
            scheduleTokenRefresh();
          }, backoffDelay);
        } else {
          console.log('💀 Max retry attempts reached, logging out');
          await logout();
        }
      }
    }, refreshInMs);

    // Also store in local ref for component cleanup
    timeoutRef.current = globalRefreshTimeout;
  };

  const startTokenRefresh = () => {
    retryCountRef.current = 0;
    scheduleTokenRefresh();
  };

  const stopTokenRefresh = () => {
    // Clear both local and global timeouts
    clearRefreshTimeout();
    if (globalRefreshTimeout) {
      clearTimeout(globalRefreshTimeout);
      globalRefreshTimeout = null;
      isRefreshScheduled = false;
    }
    retryCountRef.current = 0;
  };

  // Wake detection - check token expiry when app becomes visible
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        console.log('🌅 App became visible, checking token expiry');

        // Check if we're close to or past the scheduled refresh time
        // by checking if it's been more than 12 minutes since last refresh
        const timeSinceLastRefresh = Date.now() - (lastRefreshTimeRef.current || 0);
        const shouldRefreshImmediately = timeSinceLastRefresh > (12 * 60 * 1000);

        if (shouldRefreshImmediately) {
          console.log('⏰ Token might be expired after background, triggering immediate refresh');
          await refreshToken();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // refreshToken is stable and doesn't need to be in deps

  // Desktop power state handling - pause refresh during sleep, force on wake
  useEffect(() => {
    // Only relevant for desktop app
    if (typeof window === 'undefined' || !window.electron?.isDesktop) return;

    const handleSuspend = () => {
      console.log('😴 [Power] System suspended - pausing token refresh');
      // Clear any pending refresh timeouts
      stopTokenRefresh();
    };

    const handleResume = async (event: CustomEvent<{
      resumeTime: number;
      sleepDuration: number;
      forceRefresh: boolean;
    }>) => {
      const { sleepDuration, forceRefresh } = event.detail;
      console.log(`🌅 [Power] System resumed after ${Math.round(sleepDuration / 60000)} minutes`, {
        forceRefresh,
      });

      // Wait for network to stabilize after wake
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check network connectivity before attempting refresh
      if (!navigator.onLine) {
        console.log('📡 [Power] Network offline after wake, waiting for connection...');
        // Wait for online event before continuing (with timeout cleanup)
        await new Promise<void>(resolve => {
          let timeoutId: ReturnType<typeof setTimeout> | null = null;
          const onlineHandler = () => {
            if (timeoutId) clearTimeout(timeoutId);
            window.removeEventListener('online', onlineHandler);
            resolve();
          };
          window.addEventListener('online', onlineHandler);
          // Timeout after 30 seconds
          timeoutId = setTimeout(() => {
            window.removeEventListener('online', onlineHandler);
            resolve();
          }, 30000);
        });
      }

      // If sleep duration was significant (>5 min), force immediate refresh
      if (forceRefresh || sleepDuration > 5 * 60 * 1000) {
        console.log('🔄 [Power] Forcing immediate token refresh after wake');
        retryCountRef.current = 0; // Reset retry count
        const success = await refreshToken();

        if (success) {
          // Re-schedule normal refresh cycle
          scheduleTokenRefresh();
        } else {
          // Use exponential backoff for retry
          console.log('❌ [Power] Post-wake refresh failed, will retry with backoff');
          scheduleTokenRefresh();
        }
      } else {
        // Short sleep - just resume normal refresh schedule
        console.log('⏰ [Power] Resuming normal token refresh schedule');
        scheduleTokenRefresh();
      }
    };

    const handleUnlock = async (event: CustomEvent<{ shouldRefresh: boolean }>) => {
      const { shouldRefresh } = event.detail;
      if (shouldRefresh) {
        console.log('🔓 [Power] Screen unlocked, soft refresh check');
        // Check if refresh is needed based on time since last refresh
        const timeSinceLastRefresh = Date.now() - (lastRefreshTimeRef.current || 0);
        if (timeSinceLastRefresh > 10 * 60 * 1000) { // More than 10 minutes
          console.log('🔄 [Power] Triggering soft refresh after unlock');
          await refreshToken();
        }
      }
    };

    // Type-safe event listeners using unknown cast
    window.addEventListener('power:suspend', handleSuspend as unknown as EventListener);
    window.addEventListener('power:resume', handleResume as unknown as EventListener);
    window.addEventListener('power:unlock-screen', handleUnlock as unknown as EventListener);

    return () => {
      window.removeEventListener('power:suspend', handleSuspend as unknown as EventListener);
      window.removeEventListener('power:resume', handleResume as unknown as EventListener);
      window.removeEventListener('power:unlock-screen', handleUnlock as unknown as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // stopTokenRefresh, refreshToken, scheduleTokenRefresh are stable

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearRefreshTimeout();
    };
  }, []);

  return {
    startTokenRefresh,
    stopTokenRefresh,
    refreshToken,
    isRefreshing,
  };
}