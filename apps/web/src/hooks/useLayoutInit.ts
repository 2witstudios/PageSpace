"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./useAuth";
import { useSocket } from "./useSocket";
import { useAccessRevocation } from "./useAccessRevocation";
import { usePerformanceMonitor } from "./usePerformanceMonitor";
import { useIOSKeyboardInit } from "./useIOSKeyboardInit";
import { useTabSync } from "./useTabSync";
import { useResponsivePanels } from "./useResponsivePanels";
import { useEditingStore } from "@/stores/useEditingStore";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useHasHydrated } from "./useHasHydrated";

/**
 * Handles all layout initialization side effects.
 * This keeps Layout.tsx thin and focused on structure.
 *
 * Effects include:
 * - Socket connection for real-time features
 * - Access revocation (zero-trust security)
 * - Performance monitoring
 * - iOS keyboard listeners
 * - Tab synchronization
 * - Responsive panel handling
 * - Editing session cleanup
 * - Sheet state cleanup on breakpoint change
 * - Authentication redirect
 */
export function useLayoutInit() {
  const { isLoading, isAuthenticated } = useAuth();
  const router = useRouter();
  const hasHydrated = useHasHydrated();

  // Core initialization hooks
  useSocket();
  useAccessRevocation();
  usePerformanceMonitor();
  useIOSKeyboardInit();
  useTabSync();
  useResponsivePanels();

  const setLeftSheetOpen = useLayoutStore((state) => state.setLeftSheetOpen);
  const setRightSheetOpen = useLayoutStore((state) => state.setRightSheetOpen);

  // Clear stale editing sessions on app initialization
  useEffect(() => {
    useEditingStore.getState().clearAllSessions();
  }, []);

  // Periodic cleanup of stale editing sessions
  useEffect(() => {
    const interval = setInterval(() => {
      useEditingStore.getState().clearStaleSessions();
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  // Close sheets when leaving sheet breakpoint
  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1023px)");
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      if (!e.matches) {
        setLeftSheetOpen(false);
        setRightSheetOpen(false);
      }
    };

    // Check initial state
    handleChange(mediaQuery);

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [setLeftSheetOpen, setRightSheetOpen]);

  // Authentication redirect
  useEffect(() => {
    if (hasHydrated && !isLoading && !isAuthenticated) {
      router.push("/auth/signin");
    }
  }, [hasHydrated, isLoading, isAuthenticated, router]);

  return {
    isLoading: isLoading || !hasHydrated,
    isAuthenticated,
  };
}
