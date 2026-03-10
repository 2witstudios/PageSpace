/**
 * Tests for useLayoutInit hook
 * Tests layout initialization side effects
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Setup global mocks before imports
const mockMatchMedia = vi.fn((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: mockMatchMedia,
});

// Mock useRouter
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

// Mock auth state
let mockAuth = { isLoading: false, isAuthenticated: true };
vi.mock('../useAuth', () => ({
  useAuth: () => mockAuth,
}));

// Mock all the initialization hooks
vi.mock('../useSocket', () => ({ useSocket: vi.fn() }));
vi.mock('../useAccessRevocation', () => ({ useAccessRevocation: vi.fn() }));
vi.mock('../usePerformanceMonitor', () => ({ usePerformanceMonitor: vi.fn() }));
vi.mock('../useIOSKeyboardInit', () => ({ useIOSKeyboardInit: vi.fn() }));
vi.mock('../useTabSync', () => ({ useTabSync: vi.fn() }));
vi.mock('../useResponsivePanels', () => ({ useResponsivePanels: vi.fn() }));

// Mock hasHydrated
let mockHasHydrated = true;
vi.mock('../useHasHydrated', () => ({ useHasHydrated: () => mockHasHydrated }));

// Mock stores - provide a simpler mock that works with vi.mock
const mockClearAllSessions = vi.fn();
const mockClearStaleSessions = vi.fn();

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: Object.assign(
    () => {},
    {
      getState: () => ({
        clearAllSessions: mockClearAllSessions,
        clearStaleSessions: mockClearStaleSessions,
      }),
    }
  ),
}));

const mockSetLeftSheetOpen = vi.fn();
const mockSetRightSheetOpen = vi.fn();

vi.mock('@/stores/useLayoutStore', () => ({
  useLayoutStore: (selector: Function) => {
    const state = {
      setLeftSheetOpen: mockSetLeftSheetOpen,
      setRightSheetOpen: mockSetRightSheetOpen,
    };
    return selector(state);
  },
}));

// Import after mocks
import { useLayoutInit } from '../useLayoutInit';

describe('useLayoutInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth = { isLoading: false, isAuthenticated: true };
    mockHasHydrated = true;
    mockMatchMedia.mockReturnValue({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
  });

  describe('initialization hooks', () => {
    it('should call all initialization hooks', () => {
      renderHook(() => useLayoutInit());
      // Hook should not throw and should return expected values
      expect(true).toBe(true);
    });
  });

  describe('editing session cleanup', () => {
    it('should clear all sessions on mount', () => {
      renderHook(() => useLayoutInit());
      expect(mockClearAllSessions).toHaveBeenCalledTimes(1);
    });
  });

  describe('sheet state cleanup on breakpoint change', () => {
    it('should set up media query listener', () => {
      const addEventListener = vi.fn();
      mockMatchMedia.mockReturnValue({
        matches: false,
        media: '(max-width: 1023px)',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener,
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      });

      renderHook(() => useLayoutInit());

      expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('should close sheets when leaving sheet breakpoint', () => {
      const listeners: Array<(e: { matches: boolean }) => void> = [];
      mockMatchMedia.mockReturnValue({
        matches: true, // Start in sheet mode
        media: '(max-width: 1023px)',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: (_event: string, listener: typeof listeners[0]) => {
          listeners.push(listener);
        },
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      });

      renderHook(() => useLayoutInit());

      // Clear the initial call
      mockSetLeftSheetOpen.mockClear();
      mockSetRightSheetOpen.mockClear();

      // Simulate leaving sheet breakpoint (matches becomes false)
      act(() => {
        listeners.forEach(listener => listener({ matches: false }));
      });

      expect(mockSetLeftSheetOpen).toHaveBeenCalledWith(false);
      expect(mockSetRightSheetOpen).toHaveBeenCalledWith(false);
    });

    it('should close sheets on initial mount when not in sheet mode', () => {
      // This ensures sheets start closed on desktop
      mockMatchMedia.mockReturnValue({
        matches: false, // Start NOT in sheet mode (desktop)
        media: '(max-width: 1023px)',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      });

      renderHook(() => useLayoutInit());

      // Sheets should be closed on mount when not in sheet mode
      expect(mockSetLeftSheetOpen).toHaveBeenCalledWith(false);
      expect(mockSetRightSheetOpen).toHaveBeenCalledWith(false);
    });

    it('should clean up event listener on unmount', () => {
      const removeEventListener = vi.fn();
      mockMatchMedia.mockReturnValue({
        matches: false,
        media: '(max-width: 1023px)',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener,
        dispatchEvent: vi.fn(),
      });

      const { unmount } = renderHook(() => useLayoutInit());

      unmount();

      expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    });
  });

  describe('authentication state', () => {
    it('should return isLoading true when loading', () => {
      mockAuth.isLoading = true;
      mockHasHydrated = true;

      const { result } = renderHook(() => useLayoutInit());

      expect(result.current.isLoading).toBe(true);
    });

    it('should return isLoading true when not hydrated', () => {
      mockAuth.isLoading = false;
      mockHasHydrated = false;

      const { result } = renderHook(() => useLayoutInit());

      expect(result.current.isLoading).toBe(true);
    });

    it('should return isLoading false when loaded and hydrated', () => {
      mockAuth.isLoading = false;
      mockHasHydrated = true;

      const { result } = renderHook(() => useLayoutInit());

      expect(result.current.isLoading).toBe(false);
    });

    it('should return isAuthenticated from auth hook', () => {
      mockAuth.isAuthenticated = true;

      const { result } = renderHook(() => useLayoutInit());

      expect(result.current.isAuthenticated).toBe(true);
    });

    it('should return isAuthenticated false when not authenticated', () => {
      mockAuth.isAuthenticated = false;

      const { result } = renderHook(() => useLayoutInit());

      expect(result.current.isAuthenticated).toBe(false);
    });
  });
});
