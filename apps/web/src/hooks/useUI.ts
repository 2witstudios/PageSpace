import { useCallback } from 'react';
import { useUIStore } from '@/stores/useUIStore';

// Selector hooks for UI state - only re-render when specific values change
export const useLeftSidebar = () => {
  const isOpen = useUIStore((state) => state.leftSidebarOpen);
  const toggle = useUIStore((state) => state.toggleLeftSidebar);
  const setOpen = useUIStore((state) => state.setLeftSidebar);
  
  return { isOpen, toggle, setOpen };
};

export const useRightSidebar = () => {
  const isOpen = useUIStore((state) => state.rightSidebarOpen);
  const toggle = useUIStore((state) => state.toggleRightSidebar);
  const setOpen = useUIStore((state) => state.setRightSidebar);
  
  return { isOpen, toggle, setOpen };
};

export const useCenterView = () => {
  const viewType = useUIStore((state) => state.centerViewType);
  const setViewType = useUIStore((state) => state.setCenterViewType);
  
  return { viewType, setViewType };
};

export const useNavigationState = () => {
  const isNavigating = useUIStore((state) => state.isNavigating);
  const setNavigating = useUIStore((state) => state.setNavigating);
  
  return { isNavigating, setNavigating };
};

export const useTreeState = () => {
  const expanded = useUIStore((state) => state.treeExpanded);
  const scrollPosition = useUIStore((state) => state.treeScrollPosition);
  const setExpanded = useUIStore((state) => state.setTreeExpanded);
  const setScrollPosition = useUIStore((state) => state.setTreeScrollPosition);
  
  // Stable helpers
  const isExpanded = useCallback(
    (nodeId: string) => expanded.has(nodeId),
    [expanded]
  );
  
  const toggleExpanded = useCallback(
    (nodeId: string) => setExpanded(nodeId, !expanded.has(nodeId)),
    [expanded, setExpanded]
  );
  
  return {
    expanded,
    scrollPosition,
    setExpanded,
    setScrollPosition,
    isExpanded,
    toggleExpanded,
  };
};

// Combined hook for responsive layout
export const useResponsiveLayout = () => {
  const leftSidebar = useLeftSidebar();
  const rightSidebar = useRightSidebar();
  
  const closeAllSidebars = useCallback(() => {
    leftSidebar.setOpen(false);
    rightSidebar.setOpen(false);
  }, [leftSidebar, rightSidebar]);
  
  const openAllSidebars = useCallback(() => {
    leftSidebar.setOpen(true);
    rightSidebar.setOpen(true);
  }, [leftSidebar, rightSidebar]);
  
  return {
    leftSidebar,
    rightSidebar,
    closeAllSidebars,
    openAllSidebars,
  };
};