"use client";

import { useCallback } from "react";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useBreakpoint } from "./useBreakpoint";
import { useDeviceTier } from "./useDeviceTier";
import { dismissKeyboard } from "./useMobileKeyboard";

/**
 * Centralized panel toggle logic for left and right sidebars.
 * Handles three display modes:
 * - Sheet mode (mobile <1024px): Shown as Sheet, exclusive with each other
 * - Overlay mode (1024-1279px): Animated overlay, exclusive with each other
 * - Persistent mode (>=1280px or iPad >=1024px): Side-by-side panels
 */
export function usePanelToggles() {
  const isSheetBreakpoint = useBreakpoint("(max-width: 1023px)");
  const shouldOverlaySidebarsDefault = useBreakpoint("(max-width: 1279px)");
  const { isTablet } = useDeviceTier();

  // Tablet/iPad: sidebars become persistent at 1024px+ instead of 1280px+
  const shouldOverlayLeftSidebar = isTablet ? isSheetBreakpoint : shouldOverlaySidebarsDefault;
  const shouldOverlayRightSidebar = isTablet ? isSheetBreakpoint : shouldOverlaySidebarsDefault;

  // Sidebar state (persistent desktop mode)
  const leftSidebarOpen = useLayoutStore((state) => state.leftSidebarOpen);
  const rightSidebarOpen = useLayoutStore((state) => state.rightSidebarOpen);
  const toggleLeftSidebar = useLayoutStore((state) => state.toggleLeftSidebar);
  const toggleRightSidebar = useLayoutStore((state) => state.toggleRightSidebar);
  const setLeftSidebarOpen = useLayoutStore((state) => state.setLeftSidebarOpen);
  const setRightSidebarOpen = useLayoutStore((state) => state.setRightSidebarOpen);

  // Sheet state (mobile mode)
  const leftSheetOpen = useLayoutStore((state) => state.leftSheetOpen);
  const rightSheetOpen = useLayoutStore((state) => state.rightSheetOpen);
  const setLeftSheetOpen = useLayoutStore((state) => state.setLeftSheetOpen);
  const setRightSheetOpen = useLayoutStore((state) => state.setRightSheetOpen);

  const toggleLeftPanel = useCallback(() => {
    dismissKeyboard();

    if (isSheetBreakpoint) {
      const nextOpen = !leftSheetOpen;
      if (nextOpen && rightSheetOpen) setRightSheetOpen(false);
      setLeftSheetOpen(nextOpen);
      return;
    }

    if (shouldOverlayLeftSidebar) {
      if (leftSidebarOpen) {
        setLeftSidebarOpen(false);
      } else {
        if (shouldOverlayRightSidebar && rightSidebarOpen) setRightSidebarOpen(false);
        setLeftSidebarOpen(true);
      }
      return;
    }

    toggleLeftSidebar();
  }, [
    isSheetBreakpoint,
    leftSheetOpen,
    rightSheetOpen,
    shouldOverlayLeftSidebar,
    shouldOverlayRightSidebar,
    leftSidebarOpen,
    rightSidebarOpen,
    setLeftSheetOpen,
    setRightSheetOpen,
    setLeftSidebarOpen,
    setRightSidebarOpen,
    toggleLeftSidebar,
  ]);

  const toggleRightPanel = useCallback(() => {
    dismissKeyboard();

    if (isSheetBreakpoint) {
      const nextOpen = !rightSheetOpen;
      if (nextOpen && leftSheetOpen) setLeftSheetOpen(false);
      setRightSheetOpen(nextOpen);
      return;
    }

    if (shouldOverlayRightSidebar) {
      if (rightSidebarOpen) {
        setRightSidebarOpen(false);
      } else {
        if (shouldOverlayLeftSidebar && leftSidebarOpen) setLeftSidebarOpen(false);
        setRightSidebarOpen(true);
      }
      return;
    }

    toggleRightSidebar();
  }, [
    isSheetBreakpoint,
    leftSheetOpen,
    rightSheetOpen,
    shouldOverlayLeftSidebar,
    shouldOverlayRightSidebar,
    leftSidebarOpen,
    rightSidebarOpen,
    setLeftSheetOpen,
    setRightSheetOpen,
    setLeftSidebarOpen,
    setRightSidebarOpen,
    toggleRightSidebar,
  ]);

  const closeOverlayPanels = useCallback(() => {
    if (shouldOverlayLeftSidebar && leftSidebarOpen) setLeftSidebarOpen(false);
    if (shouldOverlayRightSidebar && rightSidebarOpen) setRightSidebarOpen(false);
  }, [shouldOverlayLeftSidebar, shouldOverlayRightSidebar, leftSidebarOpen, rightSidebarOpen, setLeftSidebarOpen, setRightSidebarOpen]);

  return {
    // Toggle functions
    toggleLeftPanel,
    toggleRightPanel,
    closeOverlayPanels,
    // Display state for conditional rendering
    isSheetBreakpoint,
    shouldOverlayLeftSidebar,
    shouldOverlayRightSidebar,
    // Sidebar visibility
    leftSidebarOpen,
    rightSidebarOpen,
    leftSheetOpen,
    rightSheetOpen,
    // Setters for external control
    setLeftSheetOpen,
    setRightSheetOpen,
    setLeftSidebarOpen,
    setRightSidebarOpen,
  };
}
