import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockUseBreakpoint = vi.hoisted(() => vi.fn());
const mockLeftSidebarOpen = vi.hoisted(() => ({ value: true }));
const mockSetLeftSidebarOpen = vi.hoisted(() => vi.fn());

vi.mock('../useBreakpoint', () => ({
  useBreakpoint: mockUseBreakpoint,
}));

vi.mock('@/stores/useLayoutStore', () => ({
  useLayoutStore: vi.fn((selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      leftSidebarOpen: mockLeftSidebarOpen.value,
      setLeftSidebarOpen: mockSetLeftSidebarOpen,
    };
    return selector(state);
  }),
}));

import { useResponsivePanels } from '../useResponsivePanels';

describe('useResponsivePanels', () => {
  beforeEach(() => {
    mockUseBreakpoint.mockReset();
    mockSetLeftSidebarOpen.mockReset();
    mockLeftSidebarOpen.value = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should auto-close left sidebar when breakpoint matches and sidebar is open', () => {
    mockUseBreakpoint.mockReturnValue(true); // shouldCloseLeft = true
    mockLeftSidebarOpen.value = true;

    renderHook(() => useResponsivePanels());

    expect(mockSetLeftSidebarOpen).toHaveBeenCalledWith(false);
  });

  it('should not close left sidebar when breakpoint does not match', () => {
    mockUseBreakpoint.mockReturnValue(false); // shouldCloseLeft = false
    mockLeftSidebarOpen.value = true;

    renderHook(() => useResponsivePanels());

    expect(mockSetLeftSidebarOpen).not.toHaveBeenCalled();
  });

  it('should not close left sidebar when sidebar is already closed', () => {
    mockUseBreakpoint.mockReturnValue(true); // shouldCloseLeft = true
    mockLeftSidebarOpen.value = false;

    renderHook(() => useResponsivePanels());

    expect(mockSetLeftSidebarOpen).not.toHaveBeenCalled();
  });

  it('should not close left sidebar when both conditions are false', () => {
    mockUseBreakpoint.mockReturnValue(false);
    mockLeftSidebarOpen.value = false;

    renderHook(() => useResponsivePanels());

    expect(mockSetLeftSidebarOpen).not.toHaveBeenCalled();
  });

  it('should use the correct media query for close-left breakpoint', () => {
    mockUseBreakpoint.mockReturnValue(false);
    mockLeftSidebarOpen.value = false;

    renderHook(() => useResponsivePanels());

    expect(mockUseBreakpoint).toHaveBeenCalledWith('(max-width: 1023px)');
  });
});
