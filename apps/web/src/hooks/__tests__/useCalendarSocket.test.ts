/**
 * useCalendarSocket Hook Tests
 *
 * Tests for the hook that subscribes to calendar socket events,
 * joins drive rooms for drive-context calendars, and debounces refresh callbacks.
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

import { useCalendarSocket } from '../useCalendarSocket';

const CALENDAR_EVENTS = [
  'calendar:created',
  'calendar:updated',
  'calendar:deleted',
  'calendar:rsvp_updated',
] as const;

describe('useCalendarSocket', () => {
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

  describe('event listener registration', () => {
    it('should register listeners for all 4 calendar events', () => {
      const onCalendarChanged = vi.fn();

      renderHook(() =>
        useCalendarSocket({
          context: 'user',
          onCalendarChanged,
        }),
      );

      for (const eventName of CALENDAR_EVENTS) {
        expect(mockSocket.on).toHaveBeenCalledWith(eventName, expect.any(Function));
      }
    });

    it('should not register listeners when socket is null', () => {
      mockGetSocket.mockReturnValue(null);
      const onCalendarChanged = vi.fn();

      renderHook(() =>
        useCalendarSocket({
          context: 'user',
          onCalendarChanged,
        }),
      );

      expect(mockSocket.on).not.toHaveBeenCalled();
    });
  });

  describe('debounced refresh callback', () => {
    it('should debounce the refresh callback when calendar events fire', () => {
      const onCalendarChanged = vi.fn();

      renderHook(() =>
        useCalendarSocket({
          context: 'user',
          onCalendarChanged,
        }),
      );

      // Trigger a calendar event
      act(() => {
        mockSocket._trigger('calendar:created');
      });

      // Should not fire immediately (debounced at 200ms)
      expect(onCalendarChanged).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(onCalendarChanged).toHaveBeenCalledTimes(1);
    });

    it('should debounce multiple rapid events into a single callback', () => {
      const onCalendarChanged = vi.fn();

      renderHook(() =>
        useCalendarSocket({
          context: 'user',
          onCalendarChanged,
        }),
      );

      // Fire multiple events rapidly
      act(() => {
        mockSocket._trigger('calendar:created');
        vi.advanceTimersByTime(50);
        mockSocket._trigger('calendar:updated');
        vi.advanceTimersByTime(50);
        mockSocket._trigger('calendar:deleted');
        vi.advanceTimersByTime(50);
        mockSocket._trigger('calendar:rsvp_updated');
      });

      expect(onCalendarChanged).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(onCalendarChanged).toHaveBeenCalledTimes(1);
    });
  });

  describe('drive context', () => {
    it('should join the drive room when context is drive and driveId is provided', () => {
      const onCalendarChanged = vi.fn();

      renderHook(() =>
        useCalendarSocket({
          context: 'drive',
          driveId: 'drive-1',
          onCalendarChanged,
        }),
      );

      expect(mockSocket.emit).toHaveBeenCalledWith('join_drive', 'drive-1');
    });

    it('should not join drive room when context is user', () => {
      const onCalendarChanged = vi.fn();

      renderHook(() =>
        useCalendarSocket({
          context: 'user',
          driveId: 'drive-1',
          onCalendarChanged,
        }),
      );

      expect(mockSocket.emit).not.toHaveBeenCalledWith('join_drive', expect.anything());
    });

    it('should not join drive room when driveId is undefined', () => {
      const onCalendarChanged = vi.fn();

      renderHook(() =>
        useCalendarSocket({
          context: 'drive',
          onCalendarChanged,
        }),
      );

      expect(mockSocket.emit).not.toHaveBeenCalledWith('join_drive', expect.anything());
    });

    it('should leave old drive and join new drive when driveId changes', () => {
      const onCalendarChanged = vi.fn();

      const { rerender } = renderHook(
        ({ driveId }: { driveId: string }) =>
          useCalendarSocket({
            context: 'drive',
            driveId,
            onCalendarChanged,
          }),
        { initialProps: { driveId: 'drive-1' } },
      );

      expect(mockSocket.emit).toHaveBeenCalledWith('join_drive', 'drive-1');

      rerender({ driveId: 'drive-2' });

      expect(mockSocket.emit).toHaveBeenCalledWith('leave_drive', 'drive-1');
      expect(mockSocket.emit).toHaveBeenCalledWith('join_drive', 'drive-2');
    });

    it('should not join drive when socket is not connected', () => {
      mockSocket.connected = false;
      const onCalendarChanged = vi.fn();

      renderHook(() =>
        useCalendarSocket({
          context: 'drive',
          driveId: 'drive-1',
          onCalendarChanged,
        }),
      );

      expect(mockSocket.emit).not.toHaveBeenCalledWith('join_drive', expect.anything());
    });
  });

  describe('reconnection handling', () => {
    it('should register a connect listener for re-joining drive on reconnection', () => {
      const onCalendarChanged = vi.fn();

      renderHook(() =>
        useCalendarSocket({
          context: 'drive',
          driveId: 'drive-1',
          onCalendarChanged,
        }),
      );

      expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
    });

    it('should re-join drive room on reconnection when ref was cleared', () => {
      const onCalendarChanged = vi.fn();

      // Start with a socket that is not yet connected
      mockSocket.connected = false;

      renderHook(() =>
        useCalendarSocket({
          context: 'drive',
          driveId: 'drive-1',
          onCalendarChanged,
        }),
      );

      // Not joined yet because socket wasn't connected
      expect(mockSocket.emit).not.toHaveBeenCalledWith('join_drive', expect.anything());

      // Simulate first connection
      mockSocket.connected = true;
      act(() => {
        mockSocket._trigger('connect');
      });

      expect(mockSocket.emit).toHaveBeenCalledWith('join_drive', 'drive-1');
    });
  });

  describe('cleanup on unmount', () => {
    it('should remove all calendar event listeners on unmount', () => {
      const onCalendarChanged = vi.fn();

      const { unmount } = renderHook(() =>
        useCalendarSocket({
          context: 'user',
          onCalendarChanged,
        }),
      );

      unmount();

      for (const eventName of CALENDAR_EVENTS) {
        expect(mockSocket.off).toHaveBeenCalledWith(eventName, expect.any(Function));
      }
    });

    it('should remove connect listener on unmount when context is drive', () => {
      const onCalendarChanged = vi.fn();

      const { unmount } = renderHook(() =>
        useCalendarSocket({
          context: 'drive',
          driveId: 'drive-1',
          onCalendarChanged,
        }),
      );

      unmount();

      expect(mockSocket.off).toHaveBeenCalledWith('connect', expect.any(Function));
    });

    it('should clear debounce timeout on unmount', () => {
      const onCalendarChanged = vi.fn();

      const { unmount } = renderHook(() =>
        useCalendarSocket({
          context: 'user',
          onCalendarChanged,
        }),
      );

      // Trigger event to start debounce
      act(() => {
        mockSocket._trigger('calendar:created');
      });

      unmount();

      // Advance timers - callback should NOT fire since we unmounted
      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(onCalendarChanged).not.toHaveBeenCalled();
    });
  });
});
