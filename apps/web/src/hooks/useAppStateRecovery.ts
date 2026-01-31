'use client';

import { useEffect, useRef, useCallback } from 'react';
import { isCapacitorApp } from './useCapacitor';

export interface UseAppStateRecoveryOptions {
  /**
   * Called when the app resumes from background.
   * Use this to refresh messages from the database.
   */
  onResume: () => Promise<void> | void;

  /**
   * Whether to enable recovery (e.g., disable during streaming)
   * @default true
   */
  enabled?: boolean;

  /**
   * Minimum time in background before triggering recovery (ms)
   * This prevents rapid focus changes from triggering unnecessary refreshes.
   * @default 5000 (5 seconds)
   */
  minBackgroundTime?: number;

  /**
   * Whether to use debug logging
   * @default false
   */
  debug?: boolean;
}

/**
 * Hook to recover app state after returning from background.
 *
 * When an AI stream is in progress and the user backgrounds the app (or switches tabs),
 * the stream continues server-side but the client may disconnect. This hook detects
 * when the app returns to foreground and triggers a refresh to fetch the completed
 * AI response from the database.
 *
 * Works with both:
 * - Capacitor native apps (App.addListener('appStateChange'))
 * - Web browsers (document.visibilitychange)
 *
 * @example
 * ```tsx
 * useAppStateRecovery({
 *   onResume: async () => {
 *     // Fetch latest messages from database
 *     await mutate(); // SWR refresh
 *   },
 *   enabled: !isStreaming, // Don't interrupt active streams
 * });
 * ```
 */
export function useAppStateRecovery({
  onResume,
  enabled = true,
  minBackgroundTime = 5000,
  debug = false,
}: UseAppStateRecoveryOptions): void {
  const backgroundStartRef = useRef<number | null>(null);
  const onResumeRef = useRef(onResume);
  const pendingRefreshRef = useRef(false);

  // Keep callback ref updated
  useEffect(() => {
    onResumeRef.current = onResume;
  }, [onResume]);

  const log = useCallback(
    (message: string, ...args: unknown[]) => {
      if (debug) {
        console.log(`[useAppStateRecovery] ${message}`, ...args);
      }
    },
    [debug]
  );

  const handleResume = useCallback(async () => {
    if (!enabled) {
      log('Resume ignored - hook disabled');
      return;
    }

    const backgroundDuration = backgroundStartRef.current
      ? Date.now() - backgroundStartRef.current
      : 0;

    if (backgroundDuration < minBackgroundTime) {
      log('Resume ignored - insufficient background time', {
        duration: backgroundDuration,
        required: minBackgroundTime,
      });
      return;
    }

    // Prevent duplicate refresh calls
    if (pendingRefreshRef.current) {
      log('Resume ignored - refresh already pending');
      return;
    }

    log('Triggering recovery refresh', { backgroundDuration });
    pendingRefreshRef.current = true;

    try {
      await onResumeRef.current();
      log('Recovery refresh complete');
    } catch (error) {
      console.error('[useAppStateRecovery] Refresh failed:', error);
    } finally {
      pendingRefreshRef.current = false;
      backgroundStartRef.current = null;
    }
  }, [enabled, minBackgroundTime, log]);

  // Capacitor app state listener
  useEffect(() => {
    if (!isCapacitorApp()) return;

    let cleanup: (() => void) | undefined;

    const setupListener = async () => {
      try {
        // Dynamic import to avoid issues in non-Capacitor environments
        const { App } = await import('@capacitor/app');

        const listener = await App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) {
            log('Capacitor: App became active');
            handleResume();
          } else {
            log('Capacitor: App went to background');
            backgroundStartRef.current = Date.now();
          }
        });

        cleanup = () => listener.remove();
      } catch {
        // Capacitor plugin not available - this is fine on web
        log('Capacitor App plugin not available');
      }
    };

    setupListener();

    return () => {
      cleanup?.();
    };
  }, [handleResume, log]);

  // Web visibility change listener
  useEffect(() => {
    // Skip on Capacitor - use the app state listener instead
    if (isCapacitorApp()) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        log('Web: Page became visible');
        handleResume();
      } else {
        log('Web: Page hidden');
        backgroundStartRef.current = Date.now();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [handleResume, log]);
}
