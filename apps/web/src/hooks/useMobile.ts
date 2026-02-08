"use client";

import { useBreakpoint } from "./useBreakpoint";
import { useIsTablet } from "./useDeviceTier";

const MOBILE_QUERY = "(max-width: 767px)";

/**
 * Returns true for mobile-sized viewports AND tablets (iPad).
 * Tablets default to mobile-optimized views for touch UX.
 * Use useDeviceTier() when you need tablet-specific rendering.
 */
export function useMobile() {
  const isSmallViewport = useBreakpoint(MOBILE_QUERY);
  const isTablet = useIsTablet();
  return isSmallViewport || isTablet;
}
