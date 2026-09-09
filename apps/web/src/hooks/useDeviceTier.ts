"use client";

import { useSyncExternalStore } from "react";
import { useBreakpoint } from "./useBreakpoint";
import { isIPad } from "@/lib/capacitor-bridge";

export type DeviceTier = "mobile" | "tablet" | "desktop";

/**
 * Synchronous tablet detection.
 *
 * Delegates to the capability bridge so the iPad threshold has one definition —
 * this used to re-implement the detection and the 768px heuristic, which meant
 * tuning one copy silently disagreed with `useCapacitor().isIPad`.
 * Device type is static for a session, so no subscription/reactivity needed.
 */
function getIsTablet(): boolean {
  return isIPad();
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
