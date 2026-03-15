/**
 * useInboxSocket Hook Tests
 *
 * Tests for the hook that listens for inbox events (DM/channel updates, read status)
 * via Socket.IO and optimistically updates the SWR cache.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createMockSocket } from '@/test/socket-mocks';

const { mockGetSocket, mockMutate, mockIsEditingActive } = vi.hoisted(() => ({
  mockGetSocket: vi.fn<() => ReturnType<typeof createMockSocket> | null>(() => null),
  mockMutate: vi.fn(),
  mockIsEditingActive: vi.fn(() => false),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => mockGetSocket(),
}));

vi.mock('swr', () => ({
  useSWRConfig: () => ({ mutate: mockMutate }),
}));

vi.mock('@/stores/useEditingStore', () => ({
  isEditingActive: () => mockIsEditingActive(),
}));

import { useInboxSocket } from '../useInboxSocket';

const INBOX_EVENTS = ['inbox:dm_updated', 'inbox:channel_updated', 'inbox:read_status_changed'] as const;

describe('useInboxSocket', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = createMockSocket();
    mockSocket.connected = true;
    mockSocket.id = 'test-socket-123';
    mockGetSocket.mockReturnValue(mockSocket);
    mockIsEditingActive.mockReturnValue(false);
  });

  describe('event listener registration', () => {
    it('should register listeners for all inbox events', () => {
      renderHook(() => useInboxSocket());

      for (const event of INBOX_EVENTS) {
        expect(mockSocket.on).toHaveBeenCalledWith(event, expect.any(Function));
      }
    });

    it('should not register listeners when socket is null', () => {
      mockGetSocket.mockReturnValue(null);

      renderHook(() => useInboxSocket());

      expect(mockSocket.on).not.toHaveBeenCalled();
    });
  });

  describe('inbox event handling', () => {
    it('should skip updates when hasLoadedRef is false (not loaded yet)', () => {
      renderHook(() => useInboxSocket());

      // hasLoadedRef defaults to false via internalRef
      act(() => {
        mockSocket._trigger('inbox:dm_updated', {
          operation: 'dm_updated',
          type: 'dm',
          id: 'conv-1',
          lastMessageAt: '2024-01-01T00:00:00Z',
        });
      });

      expect(mockMutate).not.toHaveBeenCalled();
    });

    it('should skip updates when editing is active', () => {
      mockIsEditingActive.mockReturnValue(true);

      const hasLoadedRef = { current: true };
      renderHook(() => useInboxSocket({ hasLoadedRef }));

      act(() => {
        mockSocket._trigger('inbox:dm_updated', {
          operation: 'dm_updated',
          type: 'dm',
          id: 'conv-1',
        });
      });

      expect(mockMutate).not.toHaveBeenCalled();
    });

    it('should call mutate with correct cache key when hasLoadedRef is true', () => {
      const hasLoadedRef = { current: true };

      renderHook(() => useInboxSocket({ hasLoadedRef }));

      act(() => {
        mockSocket._trigger('inbox:dm_updated', {
          operation: 'dm_updated',
          type: 'dm',
          id: 'conv-1',
          lastMessageAt: '2024-01-01T00:00:00Z',
        });
      });

      expect(mockMutate).toHaveBeenCalledWith(
        '/api/inbox?limit=20',
        expect.any(Function),
        { revalidate: false },
      );
    });

    it('should call mutate with driveId in cache key when driveId is provided', () => {
      const hasLoadedRef = { current: true };

      renderHook(() => useInboxSocket({ driveId: 'drive-1', hasLoadedRef }));

      act(() => {
        mockSocket._trigger('inbox:channel_updated', {
          operation: 'channel_updated',
          type: 'channel',
          id: 'channel-1',
        });
      });

      expect(mockMutate).toHaveBeenCalledWith(
        '/api/inbox?driveId=drive-1&limit=20',
        expect.any(Function),
        { revalidate: false },
      );
    });

    it('should handle read_status_changed events', () => {
      const hasLoadedRef = { current: true };

      renderHook(() => useInboxSocket({ hasLoadedRef }));

      act(() => {
        mockSocket._trigger('inbox:read_status_changed', {
          operation: 'read_status_changed',
          type: 'dm',
          id: 'conv-1',
          unreadCount: 0,
        });
      });

      expect(mockMutate).toHaveBeenCalledWith(
        '/api/inbox?limit=20',
        expect.any(Function),
        { revalidate: false },
      );
    });

    it('should optimistically update existing item in SWR cache', () => {
      const hasLoadedRef = { current: true };

      renderHook(() => useInboxSocket({ hasLoadedRef }));

      act(() => {
        mockSocket._trigger('inbox:dm_updated', {
          operation: 'dm_updated',
          type: 'dm',
          id: 'conv-1',
          lastMessageAt: '2024-01-02T00:00:00Z',
          lastMessagePreview: 'Hello!',
          lastMessageSender: 'Alice',
        });
      });

      // Extract the updater function from mutate call
      const updaterFn = mockMutate.mock.calls[0][1];

      // Simulate existing cache data
      const existingData = {
        items: [
          {
            id: 'conv-1',
            type: 'dm',
            lastMessageAt: '2024-01-01T00:00:00Z',
            lastMessagePreview: 'Old message',
            lastMessageSender: 'Bob',
            unreadCount: 0,
          },
        ],
      };

      const result = updaterFn(existingData);

      expect(result.items[0].lastMessagePreview).toBe('Hello!');
      expect(result.items[0].lastMessageSender).toBe('Alice');
      expect(result.items[0].lastMessageAt).toBe('2024-01-02T00:00:00Z');
    });

    it('should return current data unchanged when no existing cache data', () => {
      const hasLoadedRef = { current: true };

      renderHook(() => useInboxSocket({ hasLoadedRef }));

      act(() => {
        mockSocket._trigger('inbox:dm_updated', {
          operation: 'dm_updated',
          type: 'dm',
          id: 'conv-1',
        });
      });

      const updaterFn = mockMutate.mock.calls[0][1];
      const result = updaterFn(undefined);

      expect(result).toBeUndefined();
    });

    it('should trigger revalidation when item is not in cache', () => {
      const hasLoadedRef = { current: true };

      renderHook(() => useInboxSocket({ hasLoadedRef }));

      act(() => {
        mockSocket._trigger('inbox:dm_updated', {
          operation: 'dm_updated',
          type: 'dm',
          id: 'new-conv',
        });
      });

      const updaterFn = mockMutate.mock.calls[0][1];

      const existingData = {
        items: [
          {
            id: 'other-conv',
            type: 'dm',
            lastMessageAt: '2024-01-01T00:00:00Z',
            lastMessagePreview: 'Hey',
            lastMessageSender: 'Bob',
            unreadCount: 0,
          },
        ],
      };

      const result = updaterFn(existingData);

      // Should return current data unchanged (revalidation is triggered separately)
      expect(result).toBe(existingData);
      // Should have called mutate a second time for revalidation
      expect(mockMutate).toHaveBeenCalledWith('/api/inbox?limit=20');
    });
  });

  describe('cleanup on unmount', () => {
    it('should remove all inbox event listeners on unmount', () => {
      const { unmount } = renderHook(() => useInboxSocket());

      unmount();

      for (const event of INBOX_EVENTS) {
        expect(mockSocket.off).toHaveBeenCalledWith(event, expect.any(Function));
      }
    });
  });

  describe('return value', () => {
    it('should return hasLoadedRef', () => {
      const { result } = renderHook(() => useInboxSocket());

      expect(result.current.hasLoadedRef).toBeDefined();
      expect(result.current.hasLoadedRef.current).toBe(false);
    });

    it('should return the external hasLoadedRef when provided', () => {
      const externalRef = { current: true };
      const { result } = renderHook(() => useInboxSocket({ hasLoadedRef: externalRef }));

      expect(result.current.hasLoadedRef).toBe(externalRef);
    });

    it('should return isSocketConnected as true when socket is connected', () => {
      const { result } = renderHook(() => useInboxSocket());

      expect(result.current.isSocketConnected).toBe(true);
    });

    it('should return isSocketConnected as false when socket is null', () => {
      mockGetSocket.mockReturnValue(null);

      const { result } = renderHook(() => useInboxSocket());

      expect(result.current.isSocketConnected).toBe(false);
    });
  });
});
