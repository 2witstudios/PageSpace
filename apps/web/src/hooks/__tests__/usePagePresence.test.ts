/**
 * usePagePresence Hook Tests
 * Tests for the hook that manages page viewing presence via Socket.IO.
 * This hook emits join/leave events only - viewer state updates are
 * handled by usePageTreeSocket.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createMockSocket } from '@/test/socket-mocks';

// Create hoisted mocks
const { mockUseAuth, mockGetSocket } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockGetSocket: vi.fn<() => ReturnType<typeof createMockSocket> | null>(() => null),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => mockGetSocket(),
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
    mockGetSocket.mockReturnValue(mockSocket);
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

  describe('event listener management', () => {
    it('given mount and unmount, should not register any socket listeners', () => {
      const { unmount } = renderHook(() => usePagePresence('page-1'));

      // usePagePresence should only emit, not listen (usePageTreeSocket handles listening)
      expect(mockSocket.on).not.toHaveBeenCalled();

      unmount();
    });
  });
});
