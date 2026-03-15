import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockUseMobile = vi.hoisted(() => vi.fn(() => false));
const mockUseTouchDevice = vi.hoisted(() => vi.fn(() => false));
const mockIsAnyEditing = vi.hoisted(() => vi.fn(() => false));

vi.mock('@/lib/haptics', () => ({
  triggerHaptic: vi.fn(),
}));

vi.mock('@/hooks/useMobile', () => ({
  useMobile: mockUseMobile,
}));

vi.mock('@/hooks/useTouchDevice', () => ({
  useTouchDevice: mockUseTouchDevice,
}));

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: {
    getState: () => ({
      isAnyEditing: mockIsAnyEditing,
    }),
  },
}));

import { useChatPullToRefresh } from '../useChatPullToRefresh';

describe('useChatPullToRefresh', () => {
  const mockOnRefresh = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMobile.mockReturnValue(false);
    mockUseTouchDevice.mockReturnValue(false);
    mockIsAnyEditing.mockReturnValue(false);
    mockOnRefresh.mockResolvedValue(undefined);
  });

  describe('initial state', () => {
    it('should return pullDistance=0 initially', () => {
      const { result } = renderHook(() =>
        useChatPullToRefresh({ onRefresh: mockOnRefresh })
      );

      expect(result.current.pullDistance).toBe(0);
    });

    it('should return isPulling=false initially', () => {
      const { result } = renderHook(() =>
        useChatPullToRefresh({ onRefresh: mockOnRefresh })
      );

      expect(result.current.isPulling).toBe(false);
    });

    it('should return isRefreshing=false initially', () => {
      const { result } = renderHook(() =>
        useChatPullToRefresh({ onRefresh: mockOnRefresh })
      );

      expect(result.current.isRefreshing).toBe(false);
    });

    it('should return hasReachedThreshold=false initially', () => {
      const { result } = renderHook(() =>
        useChatPullToRefresh({ onRefresh: mockOnRefresh })
      );

      expect(result.current.hasReachedThreshold).toBe(false);
    });
  });

  describe('isAtBottom function', () => {
    it('should return false when container is null', () => {
      const { result } = renderHook(() =>
        useChatPullToRefresh({ onRefresh: mockOnRefresh })
      );

      expect(result.current.isAtBottom(null)).toBe(false);
    });

    it('should return true when container is scrolled to bottom', () => {
      const { result } = renderHook(() =>
        useChatPullToRefresh({ onRefresh: mockOnRefresh })
      );

      const container = {
        scrollHeight: 1000,
        scrollTop: 500,
        clientHeight: 500,
      } as HTMLElement;

      expect(result.current.isAtBottom(container)).toBe(true);
    });

    it('should return true with 1px tolerance at bottom', () => {
      const { result } = renderHook(() =>
        useChatPullToRefresh({ onRefresh: mockOnRefresh })
      );

      const container = {
        scrollHeight: 1000,
        scrollTop: 499,
        clientHeight: 500,
      } as HTMLElement;

      expect(result.current.isAtBottom(container)).toBe(true);
    });

    it('should return false when not scrolled to bottom', () => {
      const { result } = renderHook(() =>
        useChatPullToRefresh({ onRefresh: mockOnRefresh })
      );

      const container = {
        scrollHeight: 1000,
        scrollTop: 200,
        clientHeight: 500,
      } as HTMLElement;

      expect(result.current.isAtBottom(container)).toBe(false);
    });
  });

  describe('disabled when not mobile/touch', () => {
    it('should not start pulling when not mobile', () => {
      mockUseMobile.mockReturnValue(false);
      mockUseTouchDevice.mockReturnValue(true);

      const { result } = renderHook(() =>
        useChatPullToRefresh({ onRefresh: mockOnRefresh })
      );

      expect(result.current.touchHandlers.onTouchStart).toBeInstanceOf(Function);
      expect(result.current.isPulling).toBe(false);
    });

    it('should not start pulling when not touch device', () => {
      mockUseMobile.mockReturnValue(true);
      mockUseTouchDevice.mockReturnValue(false);

      const { result } = renderHook(() =>
        useChatPullToRefresh({ onRefresh: mockOnRefresh })
      );

      expect(result.current.touchHandlers.onTouchStart).toBeInstanceOf(Function);
      expect(result.current.isPulling).toBe(false);
    });

    it('should not start pulling when disabled prop is true', () => {
      mockUseMobile.mockReturnValue(true);
      mockUseTouchDevice.mockReturnValue(true);

      const { result } = renderHook(() =>
        useChatPullToRefresh({ onRefresh: mockOnRefresh, disabled: true })
      );

      expect(result.current.isPulling).toBe(false);
    });
  });

  describe('touch handlers', () => {
    it('should provide all touch handler functions', () => {
      const { result } = renderHook(() =>
        useChatPullToRefresh({ onRefresh: mockOnRefresh })
      );

      expect(result.current.touchHandlers.onTouchStart).toBeInstanceOf(Function);
      expect(result.current.touchHandlers.onTouchMove).toBeInstanceOf(Function);
      expect(result.current.touchHandlers.onTouchEnd).toBeInstanceOf(Function);
      expect(result.current.touchHandlers.onTouchCancel).toBeInstanceOf(Function);
    });
  });

  describe('touch cancel', () => {
    it('should reset state on touch cancel', () => {
      const { result } = renderHook(() =>
        useChatPullToRefresh({ onRefresh: mockOnRefresh })
      );

      result.current.touchHandlers.onTouchCancel();

      expect(result.current.isPulling).toBe(false);
      expect(result.current.pullDistance).toBe(0);
      expect(result.current.hasReachedThreshold).toBe(false);
    });
  });
});
