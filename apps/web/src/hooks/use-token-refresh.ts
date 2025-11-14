'use client';

import { useEffect, useRef, useState } from 'react';
import { mutate } from 'swr';
import { useRouter } from 'next/navigation';
import { post, fetchWithAuth, refreshAuthSession } from '@/lib/auth-fetch';

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
    retryAttempts = 2, // Fewer retries to avoid conflicts
    retryDelayMs = 2000 // Longer delay between retries
  } = options;

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryCountRef = useRef(0);
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
      router.push('/auth/signin');
    } catch (error) {
      console.error('Logout error:', error);
      // Force redirect even if logout fails
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
              const { useAuthStore } = await import('@/stores/auth-store');
              const authStore = useAuthStore.getState();
              authStore.setUser(userData);
              authStore.clearFailedAttempts();
            }
          } catch (error) {
            console.error('Failed to update user data after token refresh:', error);
          }

          retryCountRef.current = 0;

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
        // Retry logic
        if (retryCountRef.current < retryAttempts) {
          retryCountRef.current++;
          console.log(`❌ Token refresh failed, retrying in ${retryDelayMs}ms (attempt ${retryCountRef.current}/${retryAttempts})`);

          setTimeout(() => {
            scheduleTokenRefresh();
          }, retryDelayMs);
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