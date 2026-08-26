'use client';

import { useEffect, useState } from 'react';
import {
  getNativeCapabilities,
  getPlatform,
  isAndroid,
  isIOS,
  isNativeApp,
  type NativeCapability,
  type Platform,
} from '@/lib/capacitor-bridge';

/**
 * Platform detection re-exported from the bridge.
 *
 * This module used to carry its own copy of `isCapacitorApp`/`getPlatform`,
 * reading `window.Capacitor` a second time. That is exactly the drift the
 * capability bridge exists to remove, so these are now thin re-exports and
 * `@/lib/capacitor-bridge` is the single detection path.
 *
 * @deprecated Import from `@/lib/capacitor-bridge` directly in new code.
 */
export { isCapacitorApp, getPlatform } from '@/lib/capacitor-bridge';

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
  /**
   * What this platform can actually do.
   *
   * Prefer this over `isIOS`/`isAndroid` when gating a native feature — see
   * `hasNativeCapability` in `@/lib/capacitor-bridge`.
   */
  capabilities: Readonly<Record<NativeCapability, boolean>>;
  /** Whether state has been determined (for SSR hydration) */
  isReady: boolean;
}

/**
 * Hook to detect Capacitor native environment.
 * Provides platform and capability information for conditional rendering.
 *
 * @example
 * ```tsx
 * const { isNative, capabilities } = useCapacitor();
 *
 * if (capabilities.badge) {
 *   // this platform can set an app badge
 * }
 * ```
 */
export function useCapacitor(): CapacitorState {
  const [state, setState] = useState<CapacitorState>(() => ({
    isNative: false,
    platform: 'web',
    isIOS: false,
    isAndroid: false,
    isIPad: false,
    capabilities: getNativeCapabilities(),
    isReady: false,
  }));

  useEffect(() => {
    const platform = getPlatform();
    const isIOSPlatform = isIOS();
    // Detect iPad: iOS Capacitor + tablet-sized screen (min dimension >= 768px).
    // All iPads have min(width, height) >= 768px; all iPhones are well under.
    const isIPadDevice =
      isIOSPlatform && Math.min(window.screen.width, window.screen.height) >= 768;

    setState({
      isNative: isNativeApp(),
      platform,
      isIOS: isIOSPlatform,
      isAndroid: isAndroid(),
      isIPad: isIPadDevice,
      capabilities: getNativeCapabilities(),
      isReady: true,
    });
  }, []);

  return state;
}
