import { useCallback, useEffect, useState } from 'react';
import type { GridSelection } from '../core/selection';
import type { Bounds, Viewport } from '../core/layout';

export interface ContextMenuState {
  show: boolean;
  x: number;
  y: number;
  cell: GridSelection | null;
  bounds?: Bounds;
  viewport: Viewport;
}

const CLOSED: ContextMenuState = {
  show: false,
  x: 0,
  y: 0,
  cell: null,
  viewport: { width: 0, height: 0 },
};

/**
 * Shell hook for the desktop right-click context menu. The element bounds and
 * viewport are snapshotted when the menu opens so positioning is a pure
 * computation at render time, never a DOM read. Any outside click/contextmenu
 * closes it.
 */
export const useContextMenu = () => {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(CLOSED);

  const openContextMenu = useCallback(
    (x: number, y: number, cell: GridSelection, element: HTMLElement | null) => {
      const rect = element?.getBoundingClientRect();
      setContextMenu({
        show: true,
        x,
        y,
        cell,
        bounds: rect
          ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
          : undefined,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
    },
    []
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, show: false }));
  }, []);

  useEffect(() => {
    if (!contextMenu.show) return;
    const handleClickOutside = () => closeContextMenu();
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('contextmenu', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('contextmenu', handleClickOutside);
    };
  }, [contextMenu.show, closeContextMenu]);

  return { contextMenu, openContextMenu, closeContextMenu };
};
