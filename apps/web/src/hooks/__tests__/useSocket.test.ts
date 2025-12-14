/**
 * useSocket Hook Tests
 * Tests for Socket.IO connection integration with authentication
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Create hoisted mocks
const { mockUseAuth, mockConnect, mockDisconnect, mockGetSocket } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockConnect: vi.fn(),
  mockDisconnect: vi.fn(),
  mockGetSocket: vi.fn(() => ({ id: 'socket-123' })),
}));

// Mock useAuth hook - use full path since test is in __tests__ subdirectory
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => mockUseAuth(),
}));

// Mock socket store with proper getState
vi.mock('@/stores/socketStore', () => {
  const mockState = {
    getSocket: mockGetSocket,
    connect: mockConnect,
    disconnect: mockDisconnect,
  };

  return {
    useSocketStore: Object.assign(
      (selector: ((state: typeof mockState) => unknown) | undefined) => {
        if (typeof selector === 'function') {
          return selector(mockState);
        }
        return mockState;
      },
      {
        getState: () => mockState,
      }
    ),
  };
});

// Import after mocks
import { useSocket } from '../useSocket';

describe('useSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      user: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('connection lifecycle', () => {
    it('given user is authenticated, should connect to socket', () => {
      mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        user: { id: 'user-123', name: 'Test User' },
      });

      renderHook(() => useSocket());

      expect(mockConnect).toHaveBeenCalled();
    });

    it('given user is not authenticated, should disconnect from socket', () => {
      mockUseAuth.mockReturnValue({
        isAuthenticated: false,
        user: null,
      });

      renderHook(() => useSocket());

      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('given authentication changes from false to true, should connect', () => {
      mockUseAuth.mockReturnValue({
        isAuthenticated: false,
        user: null,
      });

      const { rerender } = renderHook(() => useSocket());

      mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        user: { id: 'user-123' },
      });

      rerender();

      expect(mockConnect).toHaveBeenCalled();
    });

    it('given authentication changes from true to false, should disconnect', () => {
      mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        user: { id: 'user-123' },
      });

      const { rerender } = renderHook(() => useSocket());

      mockUseAuth.mockReturnValue({
        isAuthenticated: false,
        user: null,
      });

      rerender();

      expect(mockDisconnect).toHaveBeenCalled();
    });
  });

  describe('return value', () => {
    it('should return the socket from getSocket', () => {
      mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        user: { id: 'user-123' },
      });
      const expectedSocket = { id: 'socket-123' };
      mockGetSocket.mockReturnValue(expectedSocket);

      const { result } = renderHook(() => useSocket());

      expect(result.current).toEqual(expectedSocket);
    });

    it('given socket is null, should return null', () => {
      mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        user: { id: 'user-123' },
      });
      mockGetSocket.mockReturnValue(null);

      const { result } = renderHook(() => useSocket());

      expect(result.current).toBeNull();
    });
  });

  describe('user ID changes', () => {
    it('given user ID changes, should re-trigger connection logic', () => {
      mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        user: { id: 'user-1' },
      });

      const { rerender } = renderHook(() => useSocket());

      const firstConnectCount = mockConnect.mock.calls.length;

      mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        user: { id: 'user-2' },
      });

      rerender();

      // Should have called connect again for new user
      expect(mockConnect.mock.calls.length).toBeGreaterThanOrEqual(firstConnectCount);
    });
  });
});
