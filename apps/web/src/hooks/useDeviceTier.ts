"use client";

import { useSyncExternalStore } from "react";
import { useBreakpoint } from "./useBreakpoint";

export type DeviceTier = "mobile" | "tablet" | "desktop";

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

/**
 * Synchronous tablet detection via Capacitor.
 * iPad is identified as iOS Capacitor with min screen dimension >= 768px.
 * Device type is static for a session, so no subscription/reactivity needed.
 */
function getIsTablet(): boolean {
  if (typeof window === "undefined") return false;
  const capacitor = (window as Window & { Capacitor?: CapacitorGlobal })
    .Capacitor;
  if (!capacitor?.isNativePlatform?.()) return false;
  if (capacitor.getPlatform?.() !== "ios") return false;
  return Math.min(window.screen.width, window.screen.height) >= 768;
}

const noopSubscribe = () => () => {};
const serverSnapshot = () => false;

/**
 * Returns whether the current device is a tablet (iPad in Capacitor).
 * Safe for SSR - returns false on server, detects synchronously on client.
 */
export function useIsTablet(): boolean {
  return useSyncExternalStore(noopSubscribe, getIsTablet, serverSnapshot);
}

/**
 * Returns the device tier for responsive rendering decisions.
 *
 * Tiers:
 * - mobile: Phone-sized viewport (<=767px)
 * - tablet: iPad in Capacitor app (real viewport, but touch-optimized)
 * - desktop: Large viewport web browser
 *
 * By default, useMobile() treats tablet as mobile so all existing mobile
 * views work on iPad automatically. Use useDeviceTier() when a component
 * needs tablet-specific rendering.
 *
 * @example
 * ```tsx
 * const { tier, isTablet } = useDeviceTier();
 *
 * // Most components: use useMobile() (returns true for mobile + tablet)
 * // Specific overrides:
 * if (isTablet) return <TabletLayout />;
 * if (tier === 'desktop') return <DesktopLayout />;
 * return <MobileLayout />;
 * ```
 */
export function useDeviceTier() {
  const isTablet = useIsTablet();
  const isSmallViewport = useBreakpoint("(max-width: 767px)");

  const tier: DeviceTier = isTablet
    ? "tablet"
    : isSmallViewport
      ? "mobile"
      : "desktop";

  return {
    tier,
    isMobile: tier === "mobile",
    isTablet: tier === "tablet",
    isDesktop: tier === "desktop",
    /** Whether the device should use mobile-optimized views (mobile + tablet) */
    isMobileOrTablet: tier !== "desktop",
  };
}
