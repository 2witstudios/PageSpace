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
   * Whether to enable recovery.
   *
   * PREFER THE CALLBACK FORM. A boolean is captured at render, and iOS freezes JS
   * the moment the app backgrounds — so the value that ends up gating the resume is
   * whatever was true when the app went away, not what is true when it comes back.
   * That is how the AI-page recovery path came to be dead in exactly the case it
   * was written for. A callback is evaluated at fire time.
   *
   * @default true
   */
  enabled?: boolean | (() => boolean);

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
 *   // Callback form — evaluated on resume, not captured at render.
 *   enabled: () => !useEditingStore.getState().isAnyEditing(),
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
  // Assigned during render so handleResume reads the latest gate without listing
  // `enabled` as a dependency (which would re-register the listeners on every flip).
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

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
    // Evaluated HERE, on resume — not captured at render. See `enabled` above.
    const gate = enabledRef.current;
    const isEnabled = typeof gate === 'function' ? gate() : gate;
    if (!isEnabled) {
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
  }, [minBackgroundTime, log]);

  // Capacitor app state listener
  useEffect(() => {
    if (!isCapacitorApp()) return;

    let cleanup: (() => void) | undefined;
    let mounted = true;

    const setupListener = async () => {
      try {
        // Dynamic import to avoid issues in non-Capacitor environments
        const { App } = await import('@capacitor/app');

        // Check if component unmounted during async import
        if (!mounted) return;

        const listener = await App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) {
            log('Capacitor: App became active');
            handleResume();
          } else {
            log('Capacitor: App went to background');
            backgroundStartRef.current = Date.now();
          }
        });

        // Check again after addListener - if unmounted, clean up immediately
        if (!mounted) {
          listener.remove();
          return;
        }

        cleanup = () => listener.remove();
      } catch {
        // Capacitor plugin not available - this is fine on web
        log('Capacitor App plugin not available');
      }
    };

    setupListener();

    return () => {
      mounted = false;
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
