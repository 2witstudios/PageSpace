/**
 * useAppStateRecovery Hook Tests
 *
 * Tests the app state recovery behavior:
 * - Triggers onResume after visibility change with sufficient background time
 * - Does not trigger when background time is too short
 * - Does not trigger when disabled
 * - Prevents duplicate refresh calls
 * - Works with web visibilitychange events
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockIsCapacitorApp = vi.hoisted(() => vi.fn(() => false));

vi.mock('../useCapacitor', () => ({
  isCapacitorApp: mockIsCapacitorApp,
}));

import { useAppStateRecovery } from '../useAppStateRecovery';

describe('useAppStateRecovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockIsCapacitorApp.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper to simulate visibility change
  function simulateVisibilityChange(state: 'hidden' | 'visible') {
    Object.defineProperty(document, 'visibilityState', {
      value: state,
      configurable: true,
      writable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  describe('web visibility change', () => {
    it('should trigger onResume after visibility change with sufficient background time', async () => {
      const onResume = vi.fn().mockResolvedValue(undefined);

      renderHook(() =>
        useAppStateRecovery({
          onResume,
          minBackgroundTime: 5000,
        })
      );

      // Go to background
      act(() => {
        simulateVisibilityChange('hidden');
      });

      // Wait more than minBackgroundTime
      act(() => {
        vi.advanceTimersByTime(6000);
      });

      // Come back to foreground
      await act(async () => {
        simulateVisibilityChange('visible');
      });

      expect(onResume).toHaveBeenCalledOnce();
    });

    it('should not trigger onResume when background time is too short', async () => {
      const onResume = vi.fn().mockResolvedValue(undefined);

      renderHook(() =>
        useAppStateRecovery({
          onResume,
          minBackgroundTime: 5000,
        })
      );

      // Go to background
      act(() => {
        simulateVisibilityChange('hidden');
      });

      // Wait less than minBackgroundTime
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      // Come back to foreground
      await act(async () => {
        simulateVisibilityChange('visible');
      });

      expect(onResume).not.toHaveBeenCalled();
    });

    it('should not trigger onResume when disabled', async () => {
      const onResume = vi.fn().mockResolvedValue(undefined);

      renderHook(() =>
        useAppStateRecovery({
          onResume,
          enabled: false,
          minBackgroundTime: 5000,
        })
      );

      // Go to background
      act(() => {
        simulateVisibilityChange('hidden');
      });

      // Wait more than minBackgroundTime
      act(() => {
        vi.advanceTimersByTime(6000);
      });

      // Come back to foreground
      await act(async () => {
        simulateVisibilityChange('visible');
      });

      expect(onResume).not.toHaveBeenCalled();
    });

    it('should not trigger when page becomes visible without going hidden first', async () => {
      const onResume = vi.fn().mockResolvedValue(undefined);

      renderHook(() =>
        useAppStateRecovery({
          onResume,
          minBackgroundTime: 5000,
        })
      );

      // Come to foreground without going hidden first (no backgroundStartRef set)
      await act(async () => {
        simulateVisibilityChange('visible');
      });

      expect(onResume).not.toHaveBeenCalled();
    });

    it('should prevent duplicate refresh calls', async () => {
      // Create a slow onResume that we can control
      let resolveResume: () => void;
      const resumePromise = new Promise<void>((resolve) => {
        resolveResume = resolve;
      });
      const onResume = vi.fn().mockReturnValue(resumePromise);

      renderHook(() =>
        useAppStateRecovery({
          onResume,
          minBackgroundTime: 1000,
        })
      );

      // Go to background
      act(() => {
        simulateVisibilityChange('hidden');
      });

      act(() => {
        vi.advanceTimersByTime(2000);
      });

      // First visibility change
      await act(async () => {
        simulateVisibilityChange('visible');
      });

      // Second visibility change while first is still pending
      act(() => {
        simulateVisibilityChange('hidden');
      });

      act(() => {
        vi.advanceTimersByTime(2000);
      });

      await act(async () => {
        simulateVisibilityChange('visible');
      });

      // Only the first call should have happened since the refresh is still pending
      expect(onResume).toHaveBeenCalledOnce();

      // Resolve the pending refresh
      await act(async () => {
        resolveResume!();
      });
    });

    it('should use default minBackgroundTime of 5000ms', async () => {
      const onResume = vi.fn().mockResolvedValue(undefined);

      renderHook(() =>
        useAppStateRecovery({
          onResume,
        })
      );

      // Go to background
      act(() => {
        simulateVisibilityChange('hidden');
      });

      // Wait 4 seconds (less than default 5s)
      act(() => {
        vi.advanceTimersByTime(4000);
      });

      await act(async () => {
        simulateVisibilityChange('visible');
      });

      expect(onResume).not.toHaveBeenCalled();

      // Go to background again
      act(() => {
        simulateVisibilityChange('hidden');
      });

      // Wait 6 seconds (more than default 5s)
      act(() => {
        vi.advanceTimersByTime(6000);
      });

      await act(async () => {
        simulateVisibilityChange('visible');
      });

      expect(onResume).toHaveBeenCalledOnce();
    });
  });

  describe('error handling', () => {
    it('should handle onResume errors gracefully', async () => {
      const error = new Error('Refresh failed');
      const onResume = vi.fn().mockRejectedValue(error);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      renderHook(() =>
        useAppStateRecovery({
          onResume,
          minBackgroundTime: 1000,
        })
      );

      act(() => {
        simulateVisibilityChange('hidden');
      });

      act(() => {
        vi.advanceTimersByTime(2000);
      });

      await act(async () => {
        simulateVisibilityChange('visible');
      });

      expect(onResume).toHaveBeenCalledOnce();
      expect(consoleSpy).toHaveBeenCalledWith(
        '[useAppStateRecovery] Refresh failed:',
        error
      );
      consoleSpy.mockRestore();
    });

    it('should allow new refreshes after a failed one', async () => {
      let callCount = 0;
      const onResume = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('First call fails');
        }
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      renderHook(() =>
        useAppStateRecovery({
          onResume,
          minBackgroundTime: 1000,
        })
      );

      // First cycle: fails
      act(() => {
        simulateVisibilityChange('hidden');
      });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      await act(async () => {
        simulateVisibilityChange('visible');
      });

      expect(onResume).toHaveBeenCalledTimes(1);

      // Second cycle: should succeed (not blocked by previous failure)
      act(() => {
        simulateVisibilityChange('hidden');
      });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      await act(async () => {
        simulateVisibilityChange('visible');
      });

      expect(onResume).toHaveBeenCalledTimes(2);
    });
  });

  describe('Capacitor behavior', () => {
    it('should not attach web visibility listener when running in Capacitor', () => {
      mockIsCapacitorApp.mockReturnValue(true);
      const addEventSpy = vi.spyOn(document, 'addEventListener');

      renderHook(() =>
        useAppStateRecovery({
          onResume: vi.fn(),
        })
      );

      const visibilityListeners = addEventSpy.mock.calls.filter(
        ([event]) => event === 'visibilitychange'
      );
      expect(visibilityListeners).toHaveLength(0);

      addEventSpy.mockRestore();
    });
  });

  describe('cleanup', () => {
    it('should remove visibility change listener on unmount', () => {
      const removeEventSpy = vi.spyOn(document, 'removeEventListener');

      const { unmount } = renderHook(() =>
        useAppStateRecovery({
          onResume: vi.fn(),
        })
      );

      unmount();

      const visibilityListeners = removeEventSpy.mock.calls.filter(
        ([event]) => event === 'visibilitychange'
      );
      expect(visibilityListeners).toHaveLength(1);

      removeEventSpy.mockRestore();
    });
  });

  describe('callback ref update', () => {
    it('should use latest onResume callback even if reference changes', async () => {
      const firstCallback = vi.fn().mockResolvedValue(undefined);
      const secondCallback = vi.fn().mockResolvedValue(undefined);

      const { rerender } = renderHook(
        ({ onResume }: { onResume: () => Promise<void> }) =>
          useAppStateRecovery({
            onResume,
            minBackgroundTime: 1000,
          }),
        { initialProps: { onResume: firstCallback } }
      );

      // Update callback
      rerender({ onResume: secondCallback });

      act(() => {
        simulateVisibilityChange('hidden');
      });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      await act(async () => {
        simulateVisibilityChange('visible');
      });

      expect(firstCallback).not.toHaveBeenCalled();
      expect(secondCallback).toHaveBeenCalledOnce();
    });
  });
});
