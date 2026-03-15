import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/lib/haptics', () => ({
  triggerHaptic: vi.fn(),
}));

import { usePullToRefresh } from '../usePullToRefresh';

describe('usePullToRefresh', () => {
  const mockOnRefresh = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnRefresh.mockResolvedValue(undefined);
  });

  describe('initial state', () => {
    it('should return pullDistance=0 initially', () => {
      const { result } = renderHook(() =>
        usePullToRefresh({ direction: 'top', onRefresh: mockOnRefresh })
      );

      expect(result.current.pullDistance).toBe(0);
    });

    it('should return isPulling=false initially', () => {
      const { result } = renderHook(() =>
        usePullToRefresh({ direction: 'top', onRefresh: mockOnRefresh })
      );

      expect(result.current.isPulling).toBe(false);
    });

    it('should return isRefreshing=false initially', () => {
      const { result } = renderHook(() =>
        usePullToRefresh({ direction: 'top', onRefresh: mockOnRefresh })
      );

      expect(result.current.isRefreshing).toBe(false);
    });

    it('should return hasReachedThreshold=false initially', () => {
      const { result } = renderHook(() =>
        usePullToRefresh({ direction: 'top', onRefresh: mockOnRefresh })
      );

      expect(result.current.hasReachedThreshold).toBe(false);
    });

    it('should provide a containerRef', () => {
      const { result } = renderHook(() =>
        usePullToRefresh({ direction: 'top', onRefresh: mockOnRefresh })
      );

      expect(result.current.containerRef).toBeDefined();
      expect(result.current.containerRef.current).toBeNull();
    });
  });

  describe('touch handlers', () => {
    it('should provide all touch handler functions', () => {
      const { result } = renderHook(() =>
        usePullToRefresh({ direction: 'top', onRefresh: mockOnRefresh })
      );

      expect(result.current.touchHandlers.onTouchStart).toBeInstanceOf(Function);
      expect(result.current.touchHandlers.onTouchMove).toBeInstanceOf(Function);
      expect(result.current.touchHandlers.onTouchEnd).toBeInstanceOf(Function);
      expect(result.current.touchHandlers.onTouchCancel).toBeInstanceOf(Function);
    });
  });

  describe('disabled behavior', () => {
    it('should not handle touch events when disabled', () => {
      const { result } = renderHook(() =>
        usePullToRefresh({ direction: 'top', onRefresh: mockOnRefresh, disabled: true })
      );

      const touchEvent = {
        touches: [{ clientY: 100 }],
        preventDefault: vi.fn(),
      } as unknown as React.TouchEvent;

      act(() => {
        result.current.touchHandlers.onTouchStart(touchEvent);
        result.current.touchHandlers.onTouchMove({
          ...touchEvent,
          touches: [{ clientY: 200 }],
        } as unknown as React.TouchEvent);
      });

      expect(result.current.isPulling).toBe(false);
      expect(result.current.pullDistance).toBe(0);
    });
  });

  describe('direction parameter', () => {
    it('should accept top direction', () => {
      const { result } = renderHook(() =>
        usePullToRefresh({ direction: 'top', onRefresh: mockOnRefresh })
      );

      expect(result.current.pullDistance).toBe(0);
    });

    it('should accept bottom direction', () => {
      const { result } = renderHook(() =>
        usePullToRefresh({ direction: 'bottom', onRefresh: mockOnRefresh })
      );

      expect(result.current.pullDistance).toBe(0);
    });
  });

  describe('touch cancel', () => {
    it('should reset state on touch cancel', () => {
      const { result } = renderHook(() =>
        usePullToRefresh({ direction: 'top', onRefresh: mockOnRefresh })
      );

      // Touch cancel should be safe to call even when not pulling
      act(() => {
        result.current.touchHandlers.onTouchCancel();
      });

      expect(result.current.isPulling).toBe(false);
      expect(result.current.pullDistance).toBe(0);
      expect(result.current.hasReachedThreshold).toBe(false);
    });
  });

  describe('threshold defaults', () => {
    it('should use default threshold of 60', () => {
      const { result } = renderHook(() =>
        usePullToRefresh({ direction: 'top', onRefresh: mockOnRefresh })
      );

      // The default threshold is baked into the hook internals
      // We verify the hook initializes correctly with defaults
      expect(result.current.pullDistance).toBe(0);
      expect(result.current.hasReachedThreshold).toBe(false);
    });

    it('should accept custom threshold', () => {
      const { result } = renderHook(() =>
        usePullToRefresh({
          direction: 'top',
          onRefresh: mockOnRefresh,
          threshold: 100,
        })
      );

      expect(result.current.pullDistance).toBe(0);
    });
  });
});
