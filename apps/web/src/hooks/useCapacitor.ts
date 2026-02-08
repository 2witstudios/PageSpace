'use client';

import { useEffect, useState } from 'react';

type Platform = 'ios' | 'android' | 'web';

interface CapacitorState {
  /** Whether running in a native Capacitor app */
  isNative: boolean;
  /** Current platform (ios, android, or web) */
  platform: Platform;
  /** Whether running specifically on iOS */
  isIOS: boolean;
  /** Whether running specifically on Android */
  isAndroid: boolean;
  /** Whether running on iPad (iOS Capacitor with tablet-sized screen) */
  isIPad: boolean;
  /** Whether state has been determined (for SSR hydration) */
  isReady: boolean;
}

/**
 * Hook to detect Capacitor native environment.
 * Provides platform information for conditional rendering and behavior.
 *
 * @example
 * ```tsx
 * const { isNative, isIOS, platform } = useCapacitor();
 *
 * if (isIOS) {
 *   // iOS-specific behavior
 * }
 * ```
 */
export function useCapacitor(): CapacitorState {
  const [state, setState] = useState<CapacitorState>({
    isNative: false,
    platform: 'web',
    isIOS: false,
    isAndroid: false,
    isIPad: false,
    isReady: false,
  });

  useEffect(() => {
    // Check for Capacitor global object
    const capacitor = (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
    const isCapacitor = typeof capacitor !== 'undefined' && capacitor.isNativePlatform?.();

    if (isCapacitor && capacitor) {
      const platform = capacitor.getPlatform?.() as Platform || 'web';
      const isIOSPlatform = platform === 'ios';
      // Detect iPad: iOS Capacitor + tablet-sized screen (min dimension >= 768px).
      // All iPads have min(width, height) >= 768px; all iPhones are well under.
      const isIPadDevice = isIOSPlatform &&
        Math.min(window.screen.width, window.screen.height) >= 768;
      setState({
        isNative: true,
        platform,
        isIOS: isIOSPlatform,
        isAndroid: platform === 'android',
        isIPad: isIPadDevice,
        isReady: true,
      });
    } else {
      setState({
        isNative: false,
        platform: 'web',
        isIOS: false,
        isAndroid: false,
        isIPad: false,
        isReady: true,
      });
    }
  }, []);

  return state;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

/**
 * Non-hook function to check if running in Capacitor.
 * Use when you need platform detection outside of React components.
 */
export function isCapacitorApp(): boolean {
  if (typeof window === 'undefined') return false;
  const capacitor = (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
  return typeof capacitor !== 'undefined' && !!capacitor.isNativePlatform?.();
}

/**
 * Get the current platform synchronously.
 * Returns 'web' if not in Capacitor or if called during SSR.
 */
export function getPlatform(): Platform {
  if (typeof window === 'undefined') return 'web';
  const capacitor = (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!capacitor?.isNativePlatform?.()) return 'web';
  return (capacitor.getPlatform?.() as Platform) || 'web';
}
