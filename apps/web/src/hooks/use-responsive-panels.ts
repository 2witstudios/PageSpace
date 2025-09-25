"use client";

import { useEffect } from "react";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useBreakpoint } from "./use-breakpoint";

const CLOSE_LEFT_QUERY = "(max-width: 1023px)";
const CLOSE_RIGHT_QUERY = "(max-width: 1279px)";

export function useResponsivePanels() {
  const shouldCloseLeft = useBreakpoint(CLOSE_LEFT_QUERY);
  const shouldCloseRight = useBreakpoint(CLOSE_RIGHT_QUERY);
  const leftSidebarOpen = useLayoutStore((state) => state.leftSidebarOpen);
  const rightSidebarOpen = useLayoutStore((state) => state.rightSidebarOpen);
  const setLeftSidebarOpen = useLayoutStore((state) => state.setLeftSidebarOpen);
  const setRightSidebarOpen = useLayoutStore((state) => state.setRightSidebarOpen);

  useEffect(() => {
    if (shouldCloseLeft && leftSidebarOpen) {
      setLeftSidebarOpen(false);
    }
  }, [shouldCloseLeft, leftSidebarOpen, setLeftSidebarOpen]);

  useEffect(() => {
    if (shouldCloseRight && rightSidebarOpen) {
      setRightSidebarOpen(false);
    }
  }, [shouldCloseRight, rightSidebarOpen, setRightSidebarOpen]);
}
