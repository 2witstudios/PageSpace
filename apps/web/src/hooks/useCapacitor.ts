'use client';

import { useEffect, useState } from 'react';
import {
  getNativeCapabilities,
  getPlatform,
  isAndroid,
  isIOS,
  isIPad,
  isNativeApp,
  NO_NATIVE_CAPABILITIES,
  type NativeCapability,
  type Platform,
} from '@/lib/capacitor-bridge';

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
  // The initial state must match what the server rendered: no native platform
  // and no capabilities. Reading the real platform here instead would make the
  // first client render disagree with the server's HTML on any native build.
  const [state, setState] = useState<CapacitorState>({
    isNative: false,
    platform: 'web',
    isIOS: false,
    isAndroid: false,
    isIPad: false,
    capabilities: NO_NATIVE_CAPABILITIES,
    isReady: false,
  });

  useEffect(() => {
    setState({
      isNative: isNativeApp(),
      platform: getPlatform(),
      isIOS: isIOS(),
      isAndroid: isAndroid(),
      isIPad: isIPad(),
      capabilities: getNativeCapabilities(),
      isReady: true,
    });
  }, []);

  return state;
}
