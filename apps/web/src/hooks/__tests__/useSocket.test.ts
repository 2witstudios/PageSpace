/**
 * useSocket Hook Tests
 * Tests for Socket.IO connection integration with authentication
 *
 * These tests validate the observable behavior of the useSocket hook:
 * - Socket instance returned based on auth state
 * - Connection lifecycle tied to authentication
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Create hoisted mocks
const { mockUseAuth, mockConnect, mockDisconnect, mockGetSocket } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockConnect: vi.fn(),
  mockDisconnect: vi.fn(),
  mockGetSocket: vi.fn<() => import('socket.io-client').Socket | null>(() => null),
}));

// Mock useAuth hook - use full path since test is in __tests__ subdirectory
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}));

// Mock socket store with proper getState
vi.mock('@/stores/useSocketStore', () => {
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
    mockGetSocket.mockReturnValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('connection lifecycle', () => {
    it('given user is authenticated, should return connected socket instance', () => {
      const expectedSocket = { id: 'socket-123', connected: true } as unknown as import('socket.io-client').Socket;
      mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        user: { id: 'user-123', name: 'Test User' },
      });
      mockGetSocket.mockReturnValue(expectedSocket);

      const { result } = renderHook(() => useSocket());

      // Primary assertion: observable outcome - socket is returned
      expect(result.current).toEqual(expectedSocket);
      // Secondary: connect was triggered
      expect(mockConnect).toHaveBeenCalled();
    });

    it('given user is not authenticated, should return null socket', () => {
      mockUseAuth.mockReturnValue({
        isAuthenticated: false,
        user: null,
      });
      mockGetSocket.mockReturnValue(null);

      const { result } = renderHook(() => useSocket());

      // Primary assertion: observable outcome - no socket returned
      expect(result.current).toBeNull();
      // Secondary: disconnect was triggered
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('given authentication changes from false to true, should return socket after connection', () => {
      mockUseAuth.mockReturnValue({
        isAuthenticated: false,
        user: null,
      });
      mockGetSocket.mockReturnValue(null);

      const { result, rerender } = renderHook(() => useSocket());

      // Initially no socket
      expect(result.current).toBeNull();

      // Simulate authentication and socket becoming available
      const connectedSocket = { id: 'socket-456', connected: true } as unknown as import('socket.io-client').Socket;
      mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        user: { id: 'user-123' },
      });
      mockGetSocket.mockReturnValue(connectedSocket);

      rerender();

      // Primary assertion: socket is now available
      expect(result.current).toEqual(connectedSocket);
    });

    it('given authentication changes from true to false, should return null socket', () => {
      const initialSocket = { id: 'socket-123', connected: true } as unknown as import('socket.io-client').Socket;
      mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        user: { id: 'user-123' },
      });
      mockGetSocket.mockReturnValue(initialSocket);

      const { result, rerender } = renderHook(() => useSocket());

      // Initially have socket
      expect(result.current).toEqual(initialSocket);

      // Simulate logout
      mockUseAuth.mockReturnValue({
        isAuthenticated: false,
        user: null,
      });
      mockGetSocket.mockReturnValue(null);

      rerender();

      // Primary assertion: socket is cleared
      expect(result.current).toBeNull();
    });
  });

  describe('return value', () => {
    it('given socket store has active socket, should return it', () => {
      mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        user: { id: 'user-123' },
      });
      const expectedSocket = { id: 'socket-123', connected: true, rooms: new Set(['room-1']) } as unknown as import('socket.io-client').Socket;
      mockGetSocket.mockReturnValue(expectedSocket);

      const { result } = renderHook(() => useSocket());

      expect(result.current).toEqual(expectedSocket);
    });

    it('given socket store has null socket, should return null', () => {
      mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        user: { id: 'user-123' },
      });
      mockGetSocket.mockReturnValue(null);

      const { result } = renderHook(() => useSocket());

      expect(result.current).toBeNull();
    });
  });

  describe('user changes', () => {
    it('given user ID changes while authenticated, should reconnect and return new socket', () => {
      // Initial user
      mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        user: { id: 'user-1' },
      });
      const socket1 = { id: 'socket-for-user-1', userId: 'user-1' } as unknown as import('socket.io-client').Socket;
      mockGetSocket.mockReturnValue(socket1);

      const { result, rerender } = renderHook(() => useSocket());

      expect(result.current).toEqual(socket1);

      // Different user logs in
      mockUseAuth.mockReturnValue({
        isAuthenticated: true,
        user: { id: 'user-2' },
      });
      const socket2 = { id: 'socket-for-user-2', userId: 'user-2' } as unknown as import('socket.io-client').Socket;
      mockGetSocket.mockReturnValue(socket2);

      rerender();

      // Primary assertion: new socket for new user
      expect(result.current).toEqual(socket2);
    });
  });
});
