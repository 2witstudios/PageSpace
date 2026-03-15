/**
 * useGlobalDriveSocket Hook Tests
 *
 * Tests for the hook that listens for global drive events (created, updated,
 * deleted, member_*) via Socket.IO and updates the drive store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createMockSocket } from '@/test/socket-mocks';

const { mockGetSocket, mockUseAuth, mockFetchDrives } = vi.hoisted(() => ({
  mockGetSocket: vi.fn<() => ReturnType<typeof createMockSocket> | null>(() => null),
  mockUseAuth: vi.fn(),
  mockFetchDrives: vi.fn(),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => mockGetSocket(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('@/hooks/useDrive', () => ({
  useDriveStore: (selector: (state: { fetchDrives: typeof mockFetchDrives }) => unknown) =>
    selector({ fetchDrives: mockFetchDrives }),
}));

import { useGlobalDriveSocket } from '../useGlobalDriveSocket';

const DRIVE_EVENTS = [
  'drive:created',
  'drive:updated',
  'drive:deleted',
  'drive:member_added',
  'drive:member_role_changed',
  'drive:member_removed',
] as const;

describe('useGlobalDriveSocket', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSocket = createMockSocket();
    mockSocket.connected = true;
    mockSocket.id = 'test-socket-123';
    mockGetSocket.mockReturnValue(mockSocket);
    mockUseAuth.mockReturnValue({ user: { id: 'user-1', name: 'Alice' } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('channel joining', () => {
    it('should join user-specific drives channel when user is authenticated', () => {
      renderHook(() => useGlobalDriveSocket());

      expect(mockSocket.emit).toHaveBeenCalledWith('join', 'user:user-1:drives');
    });

    it('should not join channel when socket is null', () => {
      mockGetSocket.mockReturnValue(null);

      renderHook(() => useGlobalDriveSocket());

      expect(mockSocket.emit).not.toHaveBeenCalled();
    });

    it('should not join channel when user is null', () => {
      mockUseAuth.mockReturnValue({ user: null });

      renderHook(() => useGlobalDriveSocket());

      expect(mockSocket.emit).not.toHaveBeenCalledWith('join', expect.anything());
    });
  });

  describe('event listener registration', () => {
    it('should register listeners for all 6 drive events', () => {
      renderHook(() => useGlobalDriveSocket());

      for (const event of DRIVE_EVENTS) {
        expect(mockSocket.on).toHaveBeenCalledWith(event, expect.any(Function));
      }
    });
  });

  describe('drive event handling', () => {
    it('should debounce fetchDrives when drive:created event fires', () => {
      renderHook(() => useGlobalDriveSocket());

      act(() => {
        mockSocket._trigger('drive:created', { driveId: 'drive-1', operation: 'created' });
      });

      // Should not call immediately (debounced at 500ms)
      expect(mockFetchDrives).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(mockFetchDrives).toHaveBeenCalledWith(true, true);
    });

    it('should debounce fetchDrives when drive:updated event fires', () => {
      renderHook(() => useGlobalDriveSocket());

      act(() => {
        mockSocket._trigger('drive:updated', { driveId: 'drive-1', operation: 'updated' });
      });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(mockFetchDrives).toHaveBeenCalledWith(true, true);
    });

    it('should debounce fetchDrives when drive:deleted event fires', () => {
      renderHook(() => useGlobalDriveSocket());

      act(() => {
        mockSocket._trigger('drive:deleted', { driveId: 'drive-1', operation: 'deleted' });
      });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(mockFetchDrives).toHaveBeenCalledWith(true, true);
    });

    it('should debounce fetchDrives when drive:member_added event fires', () => {
      renderHook(() => useGlobalDriveSocket());

      act(() => {
        mockSocket._trigger('drive:member_added', {
          driveId: 'drive-1',
          userId: 'user-2',
          operation: 'member_added',
        });
      });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(mockFetchDrives).toHaveBeenCalledWith(true, true);
    });

    it('should debounce fetchDrives when drive:member_role_changed event fires', () => {
      renderHook(() => useGlobalDriveSocket());

      act(() => {
        mockSocket._trigger('drive:member_role_changed', {
          driveId: 'drive-1',
          userId: 'user-2',
          operation: 'member_role_changed',
          role: 'ADMIN',
        });
      });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(mockFetchDrives).toHaveBeenCalledWith(true, true);
    });

    it('should debounce fetchDrives when drive:member_removed event fires', () => {
      renderHook(() => useGlobalDriveSocket());

      act(() => {
        mockSocket._trigger('drive:member_removed', {
          driveId: 'drive-1',
          userId: 'user-2',
          operation: 'member_removed',
        });
      });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(mockFetchDrives).toHaveBeenCalledWith(true, true);
    });

    it('should debounce rapid consecutive events into a single fetchDrives call', () => {
      renderHook(() => useGlobalDriveSocket());

      act(() => {
        mockSocket._trigger('drive:created', { driveId: 'drive-1', operation: 'created' });
        vi.advanceTimersByTime(100);
        mockSocket._trigger('drive:updated', { driveId: 'drive-1', operation: 'updated' });
        vi.advanceTimersByTime(100);
        mockSocket._trigger('drive:deleted', { driveId: 'drive-2', operation: 'deleted' });
      });

      expect(mockFetchDrives).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(mockFetchDrives).toHaveBeenCalledTimes(1);
    });
  });

  describe('cleanup on unmount', () => {
    it('should remove all drive event listeners on unmount', () => {
      const { unmount } = renderHook(() => useGlobalDriveSocket());

      unmount();

      for (const event of DRIVE_EVENTS) {
        expect(mockSocket.off).toHaveBeenCalledWith(event, expect.any(Function));
      }
    });

    it('should leave user-specific drives channel on unmount', () => {
      const { unmount } = renderHook(() => useGlobalDriveSocket());

      unmount();

      expect(mockSocket.emit).toHaveBeenCalledWith('leave', 'user:user-1:drives');
    });

    it('should clear pending debounced refetch on unmount', () => {
      const { unmount } = renderHook(() => useGlobalDriveSocket());

      act(() => {
        mockSocket._trigger('drive:created', { driveId: 'drive-1', operation: 'created' });
      });

      unmount();

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(mockFetchDrives).not.toHaveBeenCalled();
    });
  });

  describe('return value', () => {
    it('should return isSocketConnected as true when socket is connected', () => {
      const { result } = renderHook(() => useGlobalDriveSocket());

      expect(result.current.isSocketConnected).toBe(true);
    });

    it('should return isSocketConnected as false when socket is null', () => {
      mockGetSocket.mockReturnValue(null);

      const { result } = renderHook(() => useGlobalDriveSocket());

      expect(result.current.isSocketConnected).toBe(false);
    });

    it('should return socketId when socket is connected', () => {
      const { result } = renderHook(() => useGlobalDriveSocket());

      expect(result.current.socketId).toBe('test-socket-123');
    });

    it('should return null socketId when socket is null', () => {
      mockGetSocket.mockReturnValue(null);

      const { result } = renderHook(() => useGlobalDriveSocket());

      expect(result.current.socketId).toBe(null);
    });
  });
});
