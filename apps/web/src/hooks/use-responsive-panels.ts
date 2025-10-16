"use client";

import { useEffect } from "react";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useBreakpoint } from "./use-breakpoint";

const CLOSE_LEFT_QUERY = "(max-width: 1023px)";

export function useResponsivePanels() {
  const shouldCloseLeft = useBreakpoint(CLOSE_LEFT_QUERY);
  const leftSidebarOpen = useLayoutStore((state) => state.leftSidebarOpen);
  const setLeftSidebarOpen = useLayoutStore((state) => state.setLeftSidebarOpen);

  // Auto-close left sidebar when entering sheet mode (mobile)
  // The right sidebar overlay mode (1024-1279px) should be toggleable, so no auto-close
  useEffect(() => {
    if (shouldCloseLeft && leftSidebarOpen) {
      setLeftSidebarOpen(false);
    }
  }, [shouldCloseLeft, leftSidebarOpen, setLeftSidebarOpen]);
}
