/**
 * usePageContentSocket Hook Tests
 *
 * Tests for the hook that subscribes to page content updates via Socket.IO.
 * Ensures the hook joins drive rooms, filters events by pageId, and skips
 * events from the local socket to prevent loops.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createMockSocket } from '@/test/socket-mocks';

const { mockGetSocket } = vi.hoisted(() => ({
  mockGetSocket: vi.fn<() => ReturnType<typeof createMockSocket> | null>(() => null),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => mockGetSocket(),
}));

import { usePageContentSocket } from '../usePageContentSocket';

describe('usePageContentSocket', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = createMockSocket();
    mockSocket.connected = true;
    mockSocket.id = 'test-socket-123';
    mockGetSocket.mockReturnValue(mockSocket);
  });

  describe('drive room joining', () => {
    it('should join drive room on mount when pageId and driveId are provided', () => {
      const onContentUpdated = vi.fn();

      renderHook(() =>
        usePageContentSocket('page-1', 'drive-1', { onContentUpdated }),
      );

      expect(mockSocket.emit).toHaveBeenCalledWith('join_drive', 'drive-1');
    });

    it('should not join drive room when pageId is undefined', () => {
      const onContentUpdated = vi.fn();

      renderHook(() =>
        usePageContentSocket(undefined, 'drive-1', { onContentUpdated }),
      );

      expect(mockSocket.emit).not.toHaveBeenCalledWith('join_drive', expect.anything());
    });

    it('should not join drive room when driveId is undefined', () => {
      const onContentUpdated = vi.fn();

      renderHook(() =>
        usePageContentSocket('page-1', undefined, { onContentUpdated }),
      );

      expect(mockSocket.emit).not.toHaveBeenCalledWith('join_drive', expect.anything());
    });

    it('should not join drive room when socket is null', () => {
      mockGetSocket.mockReturnValue(null);
      const onContentUpdated = vi.fn();

      renderHook(() =>
        usePageContentSocket('page-1', 'drive-1', { onContentUpdated }),
      );

      expect(mockSocket.emit).not.toHaveBeenCalled();
    });
  });

  describe('event listening', () => {
    it('should listen for page:content-updated events', () => {
      const onContentUpdated = vi.fn();

      renderHook(() =>
        usePageContentSocket('page-1', 'drive-1', { onContentUpdated }),
      );

      expect(mockSocket.on).toHaveBeenCalledWith('page:content-updated', expect.any(Function));
    });

    it('should call onContentUpdated when matching pageId event is received', () => {
      const onContentUpdated = vi.fn();

      renderHook(() =>
        usePageContentSocket('page-1', 'drive-1', { onContentUpdated }),
      );

      act(() => {
        mockSocket._trigger('page:content-updated', {
          driveId: 'drive-1',
          pageId: 'page-1',
          operation: 'content-updated',
          title: 'Updated Title',
          socketId: 'other-socket-456',
        });
      });

      expect(onContentUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: 'page-1',
          title: 'Updated Title',
        }),
      );
    });

    it('should filter out events for different pageIds', () => {
      const onContentUpdated = vi.fn();

      renderHook(() =>
        usePageContentSocket('page-1', 'drive-1', { onContentUpdated }),
      );

      act(() => {
        mockSocket._trigger('page:content-updated', {
          driveId: 'drive-1',
          pageId: 'page-999',
          operation: 'content-updated',
          socketId: 'other-socket-456',
        });
      });

      expect(onContentUpdated).not.toHaveBeenCalled();
    });

    it('should skip events from the same socket to prevent loops', () => {
      const onContentUpdated = vi.fn();

      renderHook(() =>
        usePageContentSocket('page-1', 'drive-1', { onContentUpdated }),
      );

      act(() => {
        mockSocket._trigger('page:content-updated', {
          driveId: 'drive-1',
          pageId: 'page-1',
          operation: 'content-updated',
          socketId: 'test-socket-123', // Same as our socket ID
        });
      });

      expect(onContentUpdated).not.toHaveBeenCalled();
    });

    it('should process events without socketId (server-originated)', () => {
      const onContentUpdated = vi.fn();

      renderHook(() =>
        usePageContentSocket('page-1', 'drive-1', { onContentUpdated }),
      );

      act(() => {
        mockSocket._trigger('page:content-updated', {
          driveId: 'drive-1',
          pageId: 'page-1',
          operation: 'content-updated',
          // No socketId - server-originated
        });
      });

      expect(onContentUpdated).toHaveBeenCalled();
    });
  });

  describe('enabled option', () => {
    it('should not set up listeners when enabled is false', () => {
      const onContentUpdated = vi.fn();

      renderHook(() =>
        usePageContentSocket('page-1', 'drive-1', { onContentUpdated, enabled: false }),
      );

      expect(mockSocket.on).not.toHaveBeenCalledWith('page:content-updated', expect.any(Function));
      expect(mockSocket.emit).not.toHaveBeenCalledWith('join_drive', expect.anything());
    });

    it('should set up listeners by default (enabled defaults to true)', () => {
      const onContentUpdated = vi.fn();

      renderHook(() =>
        usePageContentSocket('page-1', 'drive-1', { onContentUpdated }),
      );

      expect(mockSocket.on).toHaveBeenCalledWith('page:content-updated', expect.any(Function));
    });
  });

  describe('drive change handling', () => {
    it('should leave old drive and join new drive when driveId changes', () => {
      const onContentUpdated = vi.fn();

      const { rerender } = renderHook(
        ({ pageId, driveId }: { pageId: string; driveId: string }) =>
          usePageContentSocket(pageId, driveId, { onContentUpdated }),
        { initialProps: { pageId: 'page-1', driveId: 'drive-1' } },
      );

      expect(mockSocket.emit).toHaveBeenCalledWith('join_drive', 'drive-1');

      rerender({ pageId: 'page-1', driveId: 'drive-2' });

      expect(mockSocket.emit).toHaveBeenCalledWith('leave_drive', 'drive-1');
      expect(mockSocket.emit).toHaveBeenCalledWith('join_drive', 'drive-2');
    });

    it('should not leave drive when driveId stays the same', () => {
      const onContentUpdated = vi.fn();

      const { rerender } = renderHook(
        ({ pageId, driveId }: { pageId: string; driveId: string }) =>
          usePageContentSocket(pageId, driveId, { onContentUpdated }),
        { initialProps: { pageId: 'page-1', driveId: 'drive-1' } },
      );

      rerender({ pageId: 'page-2', driveId: 'drive-1' });

      expect(mockSocket.emit).not.toHaveBeenCalledWith('leave_drive', expect.anything());
    });
  });

  describe('cleanup on unmount', () => {
    it('should remove page:content-updated listener on unmount', () => {
      const onContentUpdated = vi.fn();

      const { unmount } = renderHook(() =>
        usePageContentSocket('page-1', 'drive-1', { onContentUpdated }),
      );

      unmount();

      expect(mockSocket.off).toHaveBeenCalledWith('page:content-updated', expect.any(Function));
    });
  });

  describe('return value', () => {
    it('should return isConnected as true when socket is connected', () => {
      const onContentUpdated = vi.fn();

      const { result } = renderHook(() =>
        usePageContentSocket('page-1', 'drive-1', { onContentUpdated }),
      );

      expect(result.current.isConnected).toBe(true);
    });

    it('should return isConnected as false when socket is null', () => {
      mockGetSocket.mockReturnValue(null);
      const onContentUpdated = vi.fn();

      const { result } = renderHook(() =>
        usePageContentSocket('page-1', 'drive-1', { onContentUpdated }),
      );

      expect(result.current.isConnected).toBe(false);
    });

    it('should return socketId when socket is available', () => {
      const onContentUpdated = vi.fn();

      const { result } = renderHook(() =>
        usePageContentSocket('page-1', 'drive-1', { onContentUpdated }),
      );

      expect(result.current.socketId).toBe('test-socket-123');
    });

    it('should return null socketId when socket is null', () => {
      mockGetSocket.mockReturnValue(null);
      const onContentUpdated = vi.fn();

      const { result } = renderHook(() =>
        usePageContentSocket('page-1', 'drive-1', { onContentUpdated }),
      );

      expect(result.current.socketId).toBe(null);
    });
  });
});
