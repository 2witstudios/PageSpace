/**
 * Tests for usePanelToggles hook
 * Tests panel toggle logic across three display modes:
 * - Sheet mode (mobile <1024px)
 * - Overlay mode (1024-1279px)
 * - Persistent mode (>=1280px or iPad >=1024px)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePanelToggles } from '../usePanelToggles';

// Mock dependencies
const mockDismissKeyboard = vi.fn();
vi.mock('../useMobileKeyboard', () => ({
  dismissKeyboard: () => mockDismissKeyboard(),
}));

vi.mock('../useBreakpoint', () => ({
  useBreakpoint: (query: string) => {
    if (query === '(max-width: 1023px)') return mockBreakpoints.isSheetBreakpoint;
    if (query === '(max-width: 1279px)') return mockBreakpoints.shouldOverlaySidebarsDefault;
    return false;
  },
}));

vi.mock('../useDeviceTier', () => ({
  useDeviceTier: () => ({ isTablet: mockBreakpoints.isTablet }),
}));

// Mock Zustand store
const mockStore = {
  leftSidebarOpen: false,
  rightSidebarOpen: false,
  leftSheetOpen: false,
  rightSheetOpen: false,
  toggleLeftSidebar: vi.fn(() => {
    mockStore.leftSidebarOpen = !mockStore.leftSidebarOpen;
  }),
  toggleRightSidebar: vi.fn(() => {
    mockStore.rightSidebarOpen = !mockStore.rightSidebarOpen;
  }),
  setLeftSidebarOpen: vi.fn((open: boolean) => {
    mockStore.leftSidebarOpen = open;
  }),
  setRightSidebarOpen: vi.fn((open: boolean) => {
    mockStore.rightSidebarOpen = open;
  }),
  setLeftSheetOpen: vi.fn((open: boolean) => {
    mockStore.leftSheetOpen = open;
  }),
  setRightSheetOpen: vi.fn((open: boolean) => {
    mockStore.rightSheetOpen = open;
  }),
};

vi.mock('@/stores/useLayoutStore', () => ({
  useLayoutStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}));

// Control breakpoints via mutable object
let mockBreakpoints = {
  isSheetBreakpoint: false,
  shouldOverlaySidebarsDefault: false,
  isTablet: false,
};

describe('usePanelToggles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBreakpoints = {
      isSheetBreakpoint: false,
      shouldOverlaySidebarsDefault: false,
      isTablet: false,
    };
    mockStore.leftSidebarOpen = false;
    mockStore.rightSidebarOpen = false;
    mockStore.leftSheetOpen = false;
    mockStore.rightSheetOpen = false;
  });

  describe('toggleLeftPanel', () => {
    describe('given sheet mode (mobile <1024px)', () => {
      beforeEach(() => {
        mockBreakpoints.isSheetBreakpoint = true;
      });

      it('should toggle left sheet and dismiss keyboard', () => {
        const { result } = renderHook(() => usePanelToggles());

        act(() => {
          result.current.toggleLeftPanel();
        });

        expect(mockDismissKeyboard).toHaveBeenCalled();
        expect(mockStore.setLeftSheetOpen).toHaveBeenCalledWith(true);
      });

      it('should close right sheet when opening left sheet', () => {
        mockStore.rightSheetOpen = true;
        const { result } = renderHook(() => usePanelToggles());

        act(() => {
          result.current.toggleLeftPanel();
        });

        expect(mockStore.setRightSheetOpen).toHaveBeenCalledWith(false);
      });
    });

    describe('given overlay mode (1024-1279px)', () => {
      beforeEach(() => {
        mockBreakpoints.shouldOverlaySidebarsDefault = true;
      });

      it('should toggle left sidebar overlay', () => {
        const { result } = renderHook(() => usePanelToggles());

        act(() => {
          result.current.toggleLeftPanel();
        });

        expect(mockDismissKeyboard).toHaveBeenCalled();
        expect(mockStore.setLeftSidebarOpen).toHaveBeenCalledWith(true);
      });

      it('should close right sidebar when opening left overlay', () => {
        mockStore.rightSidebarOpen = true;
        const { result } = renderHook(() => usePanelToggles());

        act(() => {
          result.current.toggleLeftPanel();
        });

        expect(mockStore.setRightSidebarOpen).toHaveBeenCalledWith(false);
      });

      it('should close left sidebar when already open', () => {
        mockStore.leftSidebarOpen = true;
        const { result } = renderHook(() => usePanelToggles());

        act(() => {
          result.current.toggleLeftPanel();
        });

        expect(mockStore.setLeftSidebarOpen).toHaveBeenCalledWith(false);
      });
    });

    describe('given persistent mode (>=1280px)', () => {
      it('should toggle left sidebar via store toggle', () => {
        const { result } = renderHook(() => usePanelToggles());

        act(() => {
          result.current.toggleLeftPanel();
        });

        expect(mockDismissKeyboard).toHaveBeenCalled();
        expect(mockStore.toggleLeftSidebar).toHaveBeenCalled();
      });
    });

    describe('given iPad/tablet', () => {
      beforeEach(() => {
        mockBreakpoints.isTablet = true;
        mockBreakpoints.shouldOverlaySidebarsDefault = true;
      });

      it('should use persistent mode at 1024px+ instead of 1280px+', () => {
        const { result } = renderHook(() => usePanelToggles());

        // On iPad, shouldOverlayLeftSidebar uses isSheetBreakpoint, not shouldOverlaySidebarsDefault
        act(() => {
          result.current.toggleLeftPanel();
        });

        // Should use toggle since isSheetBreakpoint is false
        expect(mockStore.toggleLeftSidebar).toHaveBeenCalled();
      });
    });
  });

  describe('toggleRightPanel', () => {
    describe('given sheet mode', () => {
      beforeEach(() => {
        mockBreakpoints.isSheetBreakpoint = true;
      });

      it('should toggle right sheet and dismiss keyboard', () => {
        const { result } = renderHook(() => usePanelToggles());

        act(() => {
          result.current.toggleRightPanel();
        });

        expect(mockDismissKeyboard).toHaveBeenCalled();
        expect(mockStore.setRightSheetOpen).toHaveBeenCalledWith(true);
      });

      it('should close left sheet when opening right sheet', () => {
        mockStore.leftSheetOpen = true;
        const { result } = renderHook(() => usePanelToggles());

        act(() => {
          result.current.toggleRightPanel();
        });

        expect(mockStore.setLeftSheetOpen).toHaveBeenCalledWith(false);
      });
    });

    describe('given overlay mode', () => {
      beforeEach(() => {
        mockBreakpoints.shouldOverlaySidebarsDefault = true;
      });

      it('should toggle right sidebar overlay', () => {
        const { result } = renderHook(() => usePanelToggles());

        act(() => {
          result.current.toggleRightPanel();
        });

        expect(mockDismissKeyboard).toHaveBeenCalled();
        expect(mockStore.setRightSidebarOpen).toHaveBeenCalledWith(true);
      });
    });

    describe('given persistent mode', () => {
      it('should toggle right sidebar via store toggle', () => {
        const { result } = renderHook(() => usePanelToggles());

        act(() => {
          result.current.toggleRightPanel();
        });

        expect(mockDismissKeyboard).toHaveBeenCalled();
        expect(mockStore.toggleRightSidebar).toHaveBeenCalled();
      });
    });
  });

  describe('closeOverlayPanels', () => {
    it('should close left overlay if open', () => {
      mockBreakpoints.shouldOverlaySidebarsDefault = true;
      mockStore.leftSidebarOpen = true;
      const { result } = renderHook(() => usePanelToggles());

      act(() => {
        result.current.closeOverlayPanels();
      });

      expect(mockStore.setLeftSidebarOpen).toHaveBeenCalledWith(false);
    });

    it('should close right overlay if open', () => {
      mockBreakpoints.shouldOverlaySidebarsDefault = true;
      mockStore.rightSidebarOpen = true;
      const { result } = renderHook(() => usePanelToggles());

      act(() => {
        result.current.closeOverlayPanels();
      });

      expect(mockStore.setRightSidebarOpen).toHaveBeenCalledWith(false);
    });

    it('should not close panels in sheet mode', () => {
      mockBreakpoints.isSheetBreakpoint = true;
      mockStore.leftSidebarOpen = true;
      const { result } = renderHook(() => usePanelToggles());

      act(() => {
        result.current.closeOverlayPanels();
      });

      // Should not set sidebar state since we're in sheet mode
      expect(mockStore.setLeftSidebarOpen).not.toHaveBeenCalled();
    });
  });

  describe('return values', () => {
    it('should return all necessary state and setters', () => {
      const { result } = renderHook(() => usePanelToggles());

      expect(result.current).toHaveProperty('toggleLeftPanel');
      expect(result.current).toHaveProperty('toggleRightPanel');
      expect(result.current).toHaveProperty('closeOverlayPanels');
      expect(result.current).toHaveProperty('isSheetBreakpoint');
      expect(result.current).toHaveProperty('shouldOverlayLeftSidebar');
      expect(result.current).toHaveProperty('shouldOverlayRightSidebar');
      expect(result.current).toHaveProperty('leftSidebarOpen');
      expect(result.current).toHaveProperty('rightSidebarOpen');
      expect(result.current).toHaveProperty('leftSheetOpen');
      expect(result.current).toHaveProperty('rightSheetOpen');
      expect(result.current).toHaveProperty('setLeftSheetOpen');
      expect(result.current).toHaveProperty('setRightSheetOpen');
      expect(result.current).toHaveProperty('setLeftSidebarOpen');
      expect(result.current).toHaveProperty('setRightSidebarOpen');
    });
  });
});
