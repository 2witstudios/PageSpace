/**
 * usePageTreeSocket Hook Tests
 *
 * Tests for the enhanced page tree hook that listens for real-time page events
 * via Socket.IO and automatically revalidates/updates the tree.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createMockSocket } from '@/test/socket-mocks';

const {
  mockGetSocket,
  mockInvalidateTree,
  mockUpdateNode,
  mockMutate,
  mockFetchAndMergeChildren,
  mockSetPageViewers,
  mockClearAllPresence,
} = vi.hoisted(() => ({
  mockGetSocket: vi.fn<() => ReturnType<typeof createMockSocket> | null>(() => null),
  mockInvalidateTree: vi.fn(),
  mockUpdateNode: vi.fn(),
  mockMutate: vi.fn(),
  mockFetchAndMergeChildren: vi.fn(),
  mockSetPageViewers: vi.fn(),
  mockClearAllPresence: vi.fn(),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => mockGetSocket(),
}));

vi.mock('@/hooks/usePageTree', () => ({
  usePageTree: () => ({
    tree: [],
    isLoading: false,
    isError: undefined,
    mutate: mockMutate,
    updateNode: mockUpdateNode,
    fetchAndMergeChildren: mockFetchAndMergeChildren,
    childLoadingMap: {},
    invalidateTree: mockInvalidateTree,
  }),
}));

vi.mock('@/stores/usePresenceStore', () => ({
  usePresenceStore: (selector: (state: {
    setPageViewers: typeof mockSetPageViewers;
    clearAll: typeof mockClearAllPresence;
  }) => unknown) =>
    selector({
      setPageViewers: mockSetPageViewers,
      clearAll: mockClearAllPresence,
    }),
}));

import { usePageTreeSocket } from '../usePageTreeSocket';

const PAGE_EVENTS = [
  'page:created',
  'page:updated',
  'page:moved',
  'page:trashed',
  'page:restored',
  'page:content-updated',
] as const;

describe('usePageTreeSocket', () => {
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

  describe('drive room joining', () => {
    it('should join drive room when driveId is provided', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      expect(mockSocket.emit).toHaveBeenCalledWith('join_drive', 'drive-1');
    });

    it('should not join drive room when driveId is undefined', () => {
      renderHook(() => usePageTreeSocket(undefined));

      expect(mockSocket.emit).not.toHaveBeenCalledWith('join_drive', expect.anything());
    });

    it('should not join drive room when socket is null', () => {
      mockGetSocket.mockReturnValue(null);

      renderHook(() => usePageTreeSocket('drive-1'));

      expect(mockSocket.emit).not.toHaveBeenCalled();
    });
  });

  describe('event listener registration', () => {
    it('should register listeners for all 6 page events', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      for (const event of PAGE_EVENTS) {
        expect(mockSocket.on).toHaveBeenCalledWith(event, expect.any(Function));
      }
    });

    it('should register listener for presence:page_viewers', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      expect(mockSocket.on).toHaveBeenCalledWith('presence:page_viewers', expect.any(Function));
    });

    it('should register listener for disconnect event', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
    });
  });

  describe('page event handling', () => {
    it('should debounce tree revalidation when page:created event fires for the current drive', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      act(() => {
        mockSocket._trigger('page:created', {
          driveId: 'drive-1',
          pageId: 'page-1',
          operation: 'created',
          title: 'New Page',
        });
      });

      // Should not fire immediately (debounced at 100ms)
      expect(mockInvalidateTree).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(mockInvalidateTree).toHaveBeenCalledTimes(1);
    });

    it('should debounce tree revalidation when page:updated event fires', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      act(() => {
        mockSocket._trigger('page:updated', {
          driveId: 'drive-1',
          pageId: 'page-1',
          operation: 'updated',
        });
      });

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(mockInvalidateTree).toHaveBeenCalledTimes(1);
    });

    it('should debounce tree revalidation when page:moved event fires', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      act(() => {
        mockSocket._trigger('page:moved', {
          driveId: 'drive-1',
          pageId: 'page-1',
          operation: 'moved',
        });
      });

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(mockInvalidateTree).toHaveBeenCalledTimes(1);
    });

    it('should debounce tree revalidation when page:trashed event fires', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      act(() => {
        mockSocket._trigger('page:trashed', {
          driveId: 'drive-1',
          pageId: 'page-1',
          operation: 'trashed',
        });
      });

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(mockInvalidateTree).toHaveBeenCalledTimes(1);
    });

    it('should debounce tree revalidation when page:restored event fires', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      act(() => {
        mockSocket._trigger('page:restored', {
          driveId: 'drive-1',
          pageId: 'page-1',
          operation: 'restored',
        });
      });

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(mockInvalidateTree).toHaveBeenCalledTimes(1);
    });

    it('should ignore events for a different driveId', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      act(() => {
        mockSocket._trigger('page:created', {
          driveId: 'drive-999',
          pageId: 'page-1',
          operation: 'created',
        });
      });

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(mockInvalidateTree).not.toHaveBeenCalled();
    });

    it('should debounce rapid consecutive events into a single revalidation', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      act(() => {
        mockSocket._trigger('page:created', {
          driveId: 'drive-1',
          pageId: 'page-1',
          operation: 'created',
        });
        vi.advanceTimersByTime(30);
        mockSocket._trigger('page:updated', {
          driveId: 'drive-1',
          pageId: 'page-2',
          operation: 'updated',
        });
        vi.advanceTimersByTime(30);
        mockSocket._trigger('page:trashed', {
          driveId: 'drive-1',
          pageId: 'page-3',
          operation: 'trashed',
        });
      });

      expect(mockInvalidateTree).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(mockInvalidateTree).toHaveBeenCalledTimes(1);
    });
  });

  describe('content-updated event handling', () => {
    it('should skip content-updated events from the same socket', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      act(() => {
        mockSocket._trigger('page:content-updated', {
          driveId: 'drive-1',
          pageId: 'page-1',
          operation: 'content-updated',
          socketId: 'test-socket-123', // Same as our socket ID
        });
      });

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(mockInvalidateTree).not.toHaveBeenCalled();
      expect(mockUpdateNode).not.toHaveBeenCalled();
    });

    it('should revalidate when content-updated event has no pageId', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      act(() => {
        mockSocket._trigger('page:content-updated', {
          driveId: 'drive-1',
          pageId: '',
          operation: 'content-updated',
          socketId: 'other-socket-456',
        });
      });

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(mockInvalidateTree).toHaveBeenCalledTimes(1);
    });

    it('should revalidate when content-updated event has no socketId (server-side update)', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      act(() => {
        mockSocket._trigger('page:content-updated', {
          driveId: 'drive-1',
          pageId: 'page-1',
          operation: 'content-updated',
          // No socketId - server-originated
        });
      });

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(mockInvalidateTree).toHaveBeenCalledTimes(1);
    });
  });

  describe('presence handling', () => {
    it('should update presence store when presence:page_viewers event fires', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      act(() => {
        mockSocket._trigger('presence:page_viewers', {
          pageId: 'page-1',
          viewers: [
            { userId: 'user-1', name: 'Alice', image: null },
            { userId: 'user-2', name: 'Bob', image: null },
          ],
        });
      });

      expect(mockSetPageViewers).toHaveBeenCalledWith('page-1', [
        { userId: 'user-1', name: 'Alice', image: null },
        { userId: 'user-2', name: 'Bob', image: null },
      ]);
    });

    it('should clear all presence on socket disconnect', () => {
      renderHook(() => usePageTreeSocket('drive-1'));

      act(() => {
        mockSocket._trigger('disconnect');
      });

      expect(mockClearAllPresence).toHaveBeenCalled();
    });
  });

  describe('cleanup on unmount', () => {
    it('should remove all page event listeners on unmount', () => {
      const { unmount } = renderHook(() => usePageTreeSocket('drive-1'));

      unmount();

      for (const event of PAGE_EVENTS) {
        expect(mockSocket.off).toHaveBeenCalledWith(event, expect.any(Function));
      }
    });

    it('should remove presence:page_viewers listener on unmount', () => {
      const { unmount } = renderHook(() => usePageTreeSocket('drive-1'));

      unmount();

      expect(mockSocket.off).toHaveBeenCalledWith('presence:page_viewers', expect.any(Function));
    });

    it('should remove disconnect listener on unmount', () => {
      const { unmount } = renderHook(() => usePageTreeSocket('drive-1'));

      unmount();

      expect(mockSocket.off).toHaveBeenCalledWith('disconnect', expect.any(Function));
    });

    it('should clear all presence data on unmount', () => {
      const { unmount } = renderHook(() => usePageTreeSocket('drive-1'));

      unmount();

      expect(mockClearAllPresence).toHaveBeenCalled();
    });

    it('should clear pending debounce timeout on unmount', () => {
      const { unmount } = renderHook(() => usePageTreeSocket('drive-1'));

      act(() => {
        mockSocket._trigger('page:created', {
          driveId: 'drive-1',
          pageId: 'page-1',
          operation: 'created',
        });
      });

      unmount();

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(mockInvalidateTree).not.toHaveBeenCalled();
    });
  });

  describe('return value', () => {
    it('should return tree props from usePageTree', () => {
      const { result } = renderHook(() => usePageTreeSocket('drive-1'));

      expect(result.current.tree).toEqual([]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isError).toBeUndefined();
      expect(result.current.mutate).toBe(mockMutate);
      expect(result.current.updateNode).toBe(mockUpdateNode);
      expect(result.current.fetchAndMergeChildren).toBe(mockFetchAndMergeChildren);
      expect(result.current.childLoadingMap).toEqual({});
      expect(result.current.invalidateTree).toBe(mockInvalidateTree);
    });

    it('should return isSocketConnected as true when socket is connected', () => {
      const { result } = renderHook(() => usePageTreeSocket('drive-1'));

      expect(result.current.isSocketConnected).toBe(true);
    });

    it('should return isSocketConnected as false when socket is null', () => {
      mockGetSocket.mockReturnValue(null);

      const { result } = renderHook(() => usePageTreeSocket('drive-1'));

      expect(result.current.isSocketConnected).toBe(false);
    });

    it('should return socketId when socket is connected', () => {
      const { result } = renderHook(() => usePageTreeSocket('drive-1'));

      expect(result.current.socketId).toBe('test-socket-123');
    });

    it('should return null socketId when socket is null', () => {
      mockGetSocket.mockReturnValue(null);

      const { result } = renderHook(() => usePageTreeSocket('drive-1'));

      expect(result.current.socketId).toBe(null);
    });
  });
});
