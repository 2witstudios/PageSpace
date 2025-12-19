import { useCallback } from 'react';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Hook for managing page tree expansion and scroll state.
 * Used by the sidebar page tree component.
 */
export const useTreeState = () => {
  const expanded = useUIStore((state) => state.treeExpanded);
  const scrollPosition = useUIStore((state) => state.treeScrollPosition);
  const setExpanded = useUIStore((state) => state.setTreeExpanded);
  const setScrollPosition = useUIStore((state) => state.setTreeScrollPosition);

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
