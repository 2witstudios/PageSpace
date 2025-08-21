'use client';

import { useEffect, useRef, useState } from 'react';
import { mutate } from 'swr';
import { useRouter } from 'next/navigation';

interface TokenRefreshOptions {
  refreshBeforeExpiryMs?: number; // How long before expiry to refresh (default: 2 minutes)
  retryAttempts?: number; // Number of retry attempts (default: 3)
  retryDelayMs?: number; // Delay between retries (default: 1000ms)
}

// Global refresh promise to prevent concurrent refresh attempts across all instances
let globalRefreshPromise: Promise<boolean> | null = null;

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
      await fetch('/api/auth/logout', { method: 'POST' });
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
        const response = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
        });

        if (response.ok) {
          // Token refreshed successfully, update auth cache
          await mutate('/api/auth/me');
          retryCountRef.current = 0;
          
          // Dispatch custom event for other components
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('auth:refreshed'));
          }
          
          return true;
        } else if (response.status === 401) {
          // Refresh token is invalid or expired
          console.log('Refresh token expired, logging out');
          
          // Dispatch custom event for other components
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('auth:expired'));
          }
          
          await logout();
          return false;
        } else if (response.status === 429) {
          // Rate limited - don't logout, just retry later
          console.log('Token refresh rate limited');
          return false;
        } else if (response.status >= 500) {
          // Server error - don't logout, retry later
          console.log('Server error during refresh, will retry');
          return false;
        } else {
          throw new Error(`Refresh failed with status ${response.status}`);
        }
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
    clearRefreshTimeout();

    // Access tokens expire in 15 minutes, so refresh before that  
    const refreshInMs = (15 * 60 * 1000) - refreshBeforeExpiryMs; // Now 12 minutes
    
    console.log(`⏰ Scheduling token refresh in ${Math.round(refreshInMs / 1000 / 60)} minutes`);
    
    timeoutRef.current = setTimeout(async () => {
      console.log('🔄 Executing scheduled token refresh');
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
  };

  const startTokenRefresh = () => {
    retryCountRef.current = 0;
    scheduleTokenRefresh();
  };

  const stopTokenRefresh = () => {
    clearRefreshTimeout();
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