/**
 * usePagePresence Hook Tests
 * Tests for the hook that manages page viewing presence via Socket.IO.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createMockSocket } from '@/test/socket-mocks';

// Create hoisted mocks
const { mockUseAuth, mockGetSocket, mockSetPageViewers } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockGetSocket: vi.fn<() => ReturnType<typeof createMockSocket> | null>(() => null),
  mockSetPageViewers: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => mockGetSocket(),
}));

vi.mock('@/stores/usePresenceStore', () => ({
  usePresenceStore: (selector: (state: { setPageViewers: typeof mockSetPageViewers }) => unknown) => {
    return selector({ setPageViewers: mockSetPageViewers });
  },
}));

import { usePagePresence } from '../usePagePresence';

describe('usePagePresence', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = createMockSocket();
    mockSocket.connected = true;
    mockSocket.id = 'test-socket-123';
    mockUseAuth.mockReturnValue({ user: { id: 'user-1', name: 'Alice' } });
    mockGetSocket.mockReturnValue(mockSocket as unknown as ReturnType<typeof createMockSocket>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('joining presence', () => {
    it('given a pageId and authenticated user, should emit presence:join_page', () => {
      renderHook(() => usePagePresence('page-1'));

      expect(mockSocket.emit).toHaveBeenCalledWith('presence:join_page', { pageId: 'page-1' });
    });

    it('given no pageId, should not emit any events', () => {
      renderHook(() => usePagePresence(null));

      expect(mockSocket.emit).not.toHaveBeenCalled();
    });

    it('given no user, should not emit any events', () => {
      mockUseAuth.mockReturnValue({ user: null });

      renderHook(() => usePagePresence('page-1'));

      expect(mockSocket.emit).not.toHaveBeenCalled();
    });

    it('given no socket, should not throw', () => {
      mockGetSocket.mockReturnValue(null);

      expect(() => {
        renderHook(() => usePagePresence('page-1'));
      }).not.toThrow();
    });
  });

  describe('leaving presence', () => {
    it('given unmount, should emit presence:leave_page', () => {
      const { unmount } = renderHook(() => usePagePresence('page-1'));

      unmount();

      expect(mockSocket.emit).toHaveBeenCalledWith('presence:leave_page', { pageId: 'page-1' });
    });

    it('given page changes, should leave old page and join new one', () => {
      const { rerender } = renderHook(
        ({ pageId }) => usePagePresence(pageId),
        { initialProps: { pageId: 'page-1' as string | null } },
      );

      rerender({ pageId: 'page-2' });

      // Should have left old page and joined new one
      expect(mockSocket.emit).toHaveBeenCalledWith('presence:leave_page', { pageId: 'page-1' });
      expect(mockSocket.emit).toHaveBeenCalledWith('presence:join_page', { pageId: 'page-2' });
    });
  });

  describe('listening for viewer updates', () => {
    it('given a presence:page_viewers event for the current page, should update the store', () => {
      renderHook(() => usePagePresence('page-1'));

      // Simulate server broadcasting viewer update
      const viewerData = {
        pageId: 'page-1',
        viewers: [{ userId: 'user-2', socketId: 'socket-2', name: 'Bob', avatarUrl: null }],
      };
      mockSocket._trigger('presence:page_viewers', viewerData);

      expect(mockSetPageViewers).toHaveBeenCalledWith('page-1', viewerData.viewers);
    });

    it('given a presence:page_viewers event for a different page, should not update the store', () => {
      renderHook(() => usePagePresence('page-1'));

      mockSocket._trigger('presence:page_viewers', {
        pageId: 'page-other',
        viewers: [{ userId: 'user-2', socketId: 'socket-2', name: 'Bob', avatarUrl: null }],
      });

      expect(mockSetPageViewers).not.toHaveBeenCalled();
    });

    it('given unmount, should remove the event listener', () => {
      const { unmount } = renderHook(() => usePagePresence('page-1'));

      unmount();

      expect(mockSocket.off).toHaveBeenCalledWith('presence:page_viewers', expect.any(Function));
    });
  });
});
