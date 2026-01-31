/**
 * useAppStateRecovery Hook
 *
 * Provides automatic data recovery when the app returns from background.
 * This is especially important for iOS/Capacitor where HTTP streams are
 * terminated when the app is backgrounded.
 *
 * The server continues streaming and saves to DB, so when the user returns,
 * this hook triggers a refresh to fetch the completed data.
 */

import { useEffect, useRef, useCallback } from 'react';
import { isCapacitorApp, getPlatform } from '@/lib/capacitor-bridge';

interface UseAppStateRecoveryOptions {
  /** Callback when app returns from background */
  onForeground?: () => void | Promise<void>;
  /** Minimum time in background before triggering recovery (ms) */
  minBackgroundTime?: number;
  /** Whether the hook is enabled */
  enabled?: boolean;
}

interface UseAppStateRecoveryReturn {
  /** Whether the app is currently in background */
  isBackground: boolean;
  /** Time when app went to background (null if in foreground) */
  backgroundTime: number | null;
  /** Manually trigger recovery */
  triggerRecovery: () => void;
}

export function useAppStateRecovery({
  onForeground,
  minBackgroundTime = 1000, // Default: 1 second
  enabled = true,
}: UseAppStateRecoveryOptions = {}): UseAppStateRecoveryReturn {
  const backgroundTimeRef = useRef<number | null>(null);
  const isBackgroundRef = useRef(false);
  const onForegroundRef = useRef(onForeground);

  // Keep callback ref updated
  useEffect(() => {
    onForegroundRef.current = onForeground;
  }, [onForeground]);

  const triggerRecovery = useCallback(() => {
    if (onForegroundRef.current) {
      onForegroundRef.current();
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    // Handle iOS/Capacitor app state changes
    if (isCapacitorApp()) {
      let cleanup: (() => void) | undefined;

      const setupCapacitorListener = async () => {
        try {
          const { App } = await import('@capacitor/app');

          const listener = await App.addListener('appStateChange', ({ isActive }) => {
            if (!isActive) {
              // App going to background
              backgroundTimeRef.current = Date.now();
              isBackgroundRef.current = true;
            } else {
              // App returning to foreground
              const bgTime = backgroundTimeRef.current;
              const duration = bgTime ? Date.now() - bgTime : 0;

              backgroundTimeRef.current = null;
              isBackgroundRef.current = false;

              // Trigger recovery if backgrounded long enough
              if (duration >= minBackgroundTime && onForegroundRef.current) {
                console.log(`[AppState] Returning from background (${Math.round(duration / 1000)}s), triggering recovery`);
                onForegroundRef.current();
              }
            }
          });

          cleanup = () => {
            listener.remove();
          };
        } catch (error) {
          console.error('[AppState] Failed to setup Capacitor listener:', error);
        }
      };

      setupCapacitorListener();

      return () => {
        cleanup?.();
      };
    }

    // Handle web visibility changes (fallback for non-Capacitor)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        backgroundTimeRef.current = Date.now();
        isBackgroundRef.current = true;
      } else if (document.visibilityState === 'visible') {
        const bgTime = backgroundTimeRef.current;
        const duration = bgTime ? Date.now() - bgTime : 0;

        backgroundTimeRef.current = null;
        isBackgroundRef.current = false;

        if (duration >= minBackgroundTime && onForegroundRef.current) {
          console.log(`[Visibility] Returning to visible (${Math.round(duration / 1000)}s), triggering recovery`);
          onForegroundRef.current();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, minBackgroundTime]);

  return {
    isBackground: isBackgroundRef.current,
    backgroundTime: backgroundTimeRef.current,
    triggerRecovery,
  };
}
