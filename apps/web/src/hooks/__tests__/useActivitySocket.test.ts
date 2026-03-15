/**
 * useActivitySocket Hook Tests
 *
 * Tests for the hook that listens for activity events via Socket.IO,
 * joins/leaves activity rooms based on context, and debounces callbacks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createMockSocket } from '@/test/socket-mocks';

const { mockGetSocket } = vi.hoisted(() => ({
  mockGetSocket: vi.fn<() => ReturnType<typeof createMockSocket> | null>(() => null),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => mockGetSocket(),
}));

import { useActivitySocket, type ActivityContext } from '../useActivitySocket';

describe('useActivitySocket', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSocket = createMockSocket();
    mockSocket.connected = true;
    mockSocket.id = 'test-socket-123';
    mockGetSocket.mockReturnValue(mockSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('room joining', () => {
    it('should join drive activity room when context is drive', () => {
      const onActivityLogged = vi.fn();

      renderHook(() =>
        useActivitySocket({
          context: 'drive',
          contextId: 'drive-1',
          onActivityLogged,
        }),
      );

      expect(mockSocket.emit).toHaveBeenCalledWith('join_activity_drive', 'drive-1');
    });

    it('should join page activity room when context is page', () => {
      const onActivityLogged = vi.fn();

      renderHook(() =>
        useActivitySocket({
          context: 'page',
          contextId: 'page-1',
          onActivityLogged,
        }),
      );

      expect(mockSocket.emit).toHaveBeenCalledWith('join_activity_page', 'page-1');
    });

    it('should not join any room when contextId is null', () => {
      const onActivityLogged = vi.fn();

      renderHook(() =>
        useActivitySocket({
          context: 'drive',
          contextId: null,
          onActivityLogged,
        }),
      );

      expect(mockSocket.emit).not.toHaveBeenCalled();
    });

    it('should not join any room when socket is null', () => {
      mockGetSocket.mockReturnValue(null);
      const onActivityLogged = vi.fn();

      renderHook(() =>
        useActivitySocket({
          context: 'drive',
          contextId: 'drive-1',
          onActivityLogged,
        }),
      );

      // No socket, so no emit calls
      expect(mockSocket.emit).not.toHaveBeenCalled();
    });
  });

  describe('event listening', () => {
    it('should listen for activity:logged events', () => {
      const onActivityLogged = vi.fn();

      renderHook(() =>
        useActivitySocket({
          context: 'drive',
          contextId: 'drive-1',
          onActivityLogged,
        }),
      );

      expect(mockSocket.on).toHaveBeenCalledWith('activity:logged', expect.any(Function));
    });

    it('should debounce the callback when activity:logged fires', () => {
      const onActivityLogged = vi.fn();

      renderHook(() =>
        useActivitySocket({
          context: 'drive',
          contextId: 'drive-1',
          onActivityLogged,
        }),
      );

      // Trigger the event
      act(() => {
        mockSocket._trigger('activity:logged');
      });

      // Callback should not fire immediately (debounced at 300ms)
      expect(onActivityLogged).not.toHaveBeenCalled();

      // Advance past debounce time
      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(onActivityLogged).toHaveBeenCalledTimes(1);
    });

    it('should debounce rapid activity:logged events into a single callback', () => {
      const onActivityLogged = vi.fn();

      renderHook(() =>
        useActivitySocket({
          context: 'drive',
          contextId: 'drive-1',
          onActivityLogged,
        }),
      );

      // Fire multiple rapid events
      act(() => {
        mockSocket._trigger('activity:logged');
        vi.advanceTimersByTime(100);
        mockSocket._trigger('activity:logged');
        vi.advanceTimersByTime(100);
        mockSocket._trigger('activity:logged');
      });

      // Not yet called - debounce resets each time
      expect(onActivityLogged).not.toHaveBeenCalled();

      // Advance past debounce from last event
      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(onActivityLogged).toHaveBeenCalledTimes(1);
    });
  });

  describe('context changes', () => {
    it('should leave old room and join new room when context changes', () => {
      const onActivityLogged = vi.fn();

      const { rerender } = renderHook(
        ({ context, contextId }: { context: ActivityContext; contextId: string }) =>
          useActivitySocket({ context, contextId, onActivityLogged }),
        { initialProps: { context: 'drive' as ActivityContext, contextId: 'drive-1' } },
      );

      expect(mockSocket.emit).toHaveBeenCalledWith('join_activity_drive', 'drive-1');

      // Change to a different drive
      rerender({ context: 'drive' as ActivityContext, contextId: 'drive-2' });

      // Should leave old room and join new
      expect(mockSocket.emit).toHaveBeenCalledWith('leave_activity_drive', 'drive-1');
      expect(mockSocket.emit).toHaveBeenCalledWith('join_activity_drive', 'drive-2');
    });

    it('should leave drive room and join page room when context type changes', () => {
      const onActivityLogged = vi.fn();

      const { rerender } = renderHook(
        ({ context, contextId }: { context: ActivityContext; contextId: string }) =>
          useActivitySocket({ context, contextId, onActivityLogged }),
        { initialProps: { context: 'drive' as ActivityContext, contextId: 'drive-1' } },
      );

      // Switch from drive to page context
      rerender({ context: 'page' as ActivityContext, contextId: 'page-1' });

      expect(mockSocket.emit).toHaveBeenCalledWith('leave_activity_drive', 'drive-1');
      expect(mockSocket.emit).toHaveBeenCalledWith('join_activity_page', 'page-1');
    });
  });

  describe('cleanup on unmount', () => {
    it('should remove activity:logged listener on unmount', () => {
      const onActivityLogged = vi.fn();

      const { unmount } = renderHook(() =>
        useActivitySocket({
          context: 'drive',
          contextId: 'drive-1',
          onActivityLogged,
        }),
      );

      unmount();

      expect(mockSocket.off).toHaveBeenCalledWith('activity:logged', expect.any(Function));
    });

    it('should leave room on unmount when connected', () => {
      const onActivityLogged = vi.fn();

      const { unmount } = renderHook(() =>
        useActivitySocket({
          context: 'drive',
          contextId: 'drive-1',
          onActivityLogged,
        }),
      );

      unmount();

      expect(mockSocket.emit).toHaveBeenCalledWith('leave_activity_drive', 'drive-1');
    });

    it('should leave page room on unmount when context is page', () => {
      const onActivityLogged = vi.fn();

      const { unmount } = renderHook(() =>
        useActivitySocket({
          context: 'page',
          contextId: 'page-1',
          onActivityLogged,
        }),
      );

      unmount();

      expect(mockSocket.emit).toHaveBeenCalledWith('leave_activity_page', 'page-1');
    });

    it('should clear debounce timeout on unmount', () => {
      const onActivityLogged = vi.fn();

      const { unmount } = renderHook(() =>
        useActivitySocket({
          context: 'drive',
          contextId: 'drive-1',
          onActivityLogged,
        }),
      );

      // Fire event to start debounce
      act(() => {
        mockSocket._trigger('activity:logged');
      });

      unmount();

      // Advance timers - callback should NOT fire since we unmounted
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(onActivityLogged).not.toHaveBeenCalled();
    });
  });

  describe('return value', () => {
    it('should return isSocketConnected as true when socket is connected', () => {
      const onActivityLogged = vi.fn();

      const { result } = renderHook(() =>
        useActivitySocket({
          context: 'drive',
          contextId: 'drive-1',
          onActivityLogged,
        }),
      );

      expect(result.current.isSocketConnected).toBe(true);
    });

    it('should return isSocketConnected as false when socket is null', () => {
      mockGetSocket.mockReturnValue(null);
      const onActivityLogged = vi.fn();

      const { result } = renderHook(() =>
        useActivitySocket({
          context: 'drive',
          contextId: 'drive-1',
          onActivityLogged,
        }),
      );

      expect(result.current.isSocketConnected).toBe(false);
    });
  });
});
