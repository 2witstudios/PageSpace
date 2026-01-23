/**
 * socketStore Tests
 * Tests for Socket.IO connection management, token handling, and reconnection logic
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockSocket, createMockElectron, createWindowEventMock } from '../../test/socket-mocks';

// Mock socket.io-client before importing the store
const mockSocket = createMockSocket();
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocket),
}));

// Mock auth-fetch module for unified refresh mechanism
const mockRefreshAuthSession = vi.fn();
const mockClearSessionCache = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  refreshAuthSession: () => mockRefreshAuthSession(),
  clearSessionCache: () => mockClearSessionCache(),
}));

// Import after mocks are set up
import { useSocketStore } from '../useSocketStore';
import { io } from 'socket.io-client';

describe('useSocketStore', () => {
  const windowEventMock = createWindowEventMock();
  const originalWindow = { ...global.window };
  const originalFetch = global.fetch;

  // Helper to create mock fetch response for socket token
  const mockSocketTokenFetch = (token: string | null) => {
    return vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/socket-token') {
        if (token) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ token, expiresAt: new Date(Date.now() + 300000).toISOString() }),
          });
        }
        return Promise.resolve({ ok: false, status: 401 });
      }
      // Default response for other endpoints (e.g., /api/auth/refresh)
      return Promise.resolve({ ok: true });
    });
  };

  beforeEach(() => {
    // Reset the store state
    useSocketStore.setState({
      socket: null,
      connectionStatus: 'disconnected',
      isInitialized: false,
    });

    // Reset all mocks
    vi.clearAllMocks();
    mockSocket.connected = false;
    mockSocket.auth = {};
    mockSocket.io.opts.reconnection = true;
    mockSocket._handlers.clear();

    // Reset auth-fetch mocks with default success behavior
    mockRefreshAuthSession.mockResolvedValue({ success: true, shouldLogout: false });
    mockClearSessionCache.mockClear();

    // Mock window event listeners
    Object.defineProperty(global, 'window', {
      value: {
        ...originalWindow,
        addEventListener: windowEventMock.addEventListener,
        removeEventListener: windowEventMock.removeEventListener,
        dispatchEvent: windowEventMock.dispatchEvent,
        electron: undefined,
      },
      writable: true,
    });

    // Mock fetch - default to returning a valid socket token
    global.fetch = mockSocketTokenFetch('ps_sock_test-token-123');
  });

  afterEach(() => {
    Object.defineProperty(global, 'window', {
      value: originalWindow,
      writable: true,
    });
    global.fetch = originalFetch;
  });

  describe('initial state', () => {
    it('given store is created, should have null socket', () => {
      const { socket } = useSocketStore.getState();
      expect(socket).toBeNull();
    });

    it('given store is created, should have disconnected status', () => {
      const { connectionStatus } = useSocketStore.getState();
      expect(connectionStatus).toBe('disconnected');
    });

    it('given store is created, should not be initialized', () => {
      const { isInitialized } = useSocketStore.getState();
      expect(isInitialized).toBe(false);
    });
  });

  describe('web token retrieval', () => {
    it('given web environment with valid session, should fetch socket token from endpoint', async () => {
      const mockToken = 'ps_sock_web-test-token';
      global.fetch = mockSocketTokenFetch(mockToken);

      const { connect } = useSocketStore.getState();
      await connect();

      expect(global.fetch).toHaveBeenCalledWith('/api/auth/socket-token', { credentials: 'include' });
      const callArgs = vi.mocked(io).mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        auth: { token: mockToken },
      });
    });

    it('given web environment without valid session, should pass undefined token', async () => {
      global.fetch = mockSocketTokenFetch(null);

      const { connect } = useSocketStore.getState();
      await connect();

      const callArgs = vi.mocked(io).mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        auth: { token: undefined },
      });
    });
  });

  describe('desktop token retrieval', () => {
    it('given Electron environment with stored session token, should retrieve token from secure storage', async () => {
      const mockToken = 'desktop-test-token';
      const mockElectron = createMockElectron();
      mockElectron.auth.getSessionToken.mockResolvedValue(mockToken);

      Object.defineProperty(global, 'window', {
        value: {
          ...global.window,
          electron: mockElectron,
          addEventListener: windowEventMock.addEventListener,
          removeEventListener: windowEventMock.removeEventListener,
        },
        writable: true,
      });

      const { connect } = useSocketStore.getState();
      await connect();

      expect(mockElectron.auth.getSessionToken).toHaveBeenCalled();
      const callArgs = vi.mocked(io).mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        auth: { token: mockToken },
      });
    });
  });

  describe('connection creation', () => {
    it('given valid token available, should create Socket.IO client with auth.token', async () => {
      const mockToken = 'ps_sock_test-token';
      global.fetch = mockSocketTokenFetch(mockToken);

      const { connect } = useSocketStore.getState();
      await connect();

      const callArgs = vi.mocked(io).mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        auth: { token: mockToken },
      });
    });

    it('given socket is created, should include withCredentials option', async () => {
      const { connect } = useSocketStore.getState();
      await connect();

      const callArgs = vi.mocked(io).mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        withCredentials: true,
      });
    });

    it('given socket is created, should include reconnection settings', async () => {
      const { connect } = useSocketStore.getState();
      await connect();

      const callArgs = vi.mocked(io).mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });
    });
  });

  describe('connection events', () => {
    it('given socket connects successfully, should set status to connected', async () => {
      const { connect } = useSocketStore.getState();
      await connect();

      // Trigger the connect event
      mockSocket._trigger('connect');

      const { connectionStatus } = useSocketStore.getState();
      expect(connectionStatus).toBe('connected');
    });

    it('given socket disconnects, should set status to disconnected', async () => {
      const { connect } = useSocketStore.getState();
      await connect();

      mockSocket._trigger('connect');
      mockSocket._trigger('disconnect', 'io client disconnect');

      const { connectionStatus } = useSocketStore.getState();
      expect(connectionStatus).toBe('disconnected');
    });
  });

  describe('auth error handling', () => {
    it('given Authentication error in connect_error, should pause reconnection', async () => {
      const { connect } = useSocketStore.getState();
      await connect();

      mockSocket._trigger('connect_error', new Error('Authentication error: Invalid token'));

      expect(mockSocket.io.opts.reconnection).toBe(false);
    });

    it('given Authentication error, should attempt token refresh via unified auth-fetch after delay', async () => {
      vi.useFakeTimers();

      const { connect } = useSocketStore.getState();
      await connect();

      mockSocket._trigger('connect_error', new Error('Authentication error: Invalid token'));

      // Fast-forward past the 2 second delay
      await vi.advanceTimersByTimeAsync(2100);

      // Should use the unified refreshAuthSession instead of direct fetch
      expect(mockRefreshAuthSession).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('token refresh success', () => {
    it('given refreshAuthSession returns success, should update socket.auth with new token', async () => {
      vi.useFakeTimers();

      const newToken = 'ps_sock_refreshed-token';
      // Mock refreshAuthSession to return success
      mockRefreshAuthSession.mockResolvedValue({ success: true, shouldLogout: false });

      // Mock fetch to return different tokens for different calls to socket-token endpoint
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/auth/socket-token') {
          callCount++;
          // First call returns initial token, subsequent calls return new token
          const token = callCount === 1 ? 'ps_sock_initial-token' : newToken;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ token, expiresAt: new Date(Date.now() + 300000).toISOString() }),
          });
        }
        return Promise.resolve({ ok: true });
      });

      const { connect } = useSocketStore.getState();
      await connect();

      mockSocket._trigger('connect_error', new Error('Authentication error: Invalid token'));

      await vi.advanceTimersByTimeAsync(2100);

      // Verify unified refresh was called
      expect(mockRefreshAuthSession).toHaveBeenCalled();
      // Verify session cache was cleared
      expect(mockClearSessionCache).toHaveBeenCalled();
      // Verify socket gets new token and reconnects
      expect(mockSocket.auth).toEqual({ token: newToken });
      expect(mockSocket.connect).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('token refresh failure', () => {
    it('given refreshAuthSession returns failure, should set status to error', async () => {
      vi.useFakeTimers();

      // Mock refreshAuthSession to return failure (but not requiring logout)
      mockRefreshAuthSession.mockResolvedValue({ success: false, shouldLogout: false });

      const { connect } = useSocketStore.getState();
      await connect();

      mockSocket._trigger('connect_error', new Error('Authentication error: Invalid token'));

      await vi.advanceTimersByTimeAsync(2100);

      // Verify unified refresh was attempted
      expect(mockRefreshAuthSession).toHaveBeenCalled();
      // Verify connection status is set to error
      const { connectionStatus } = useSocketStore.getState();
      expect(connectionStatus).toBe('error');

      vi.useRealTimers();
    });
  });

  describe('proactive reconnect', () => {
    it('given auth:refreshed event fires while connected, should force reconnect', async () => {
      const { connect } = useSocketStore.getState();
      await connect();

      mockSocket.connected = true;
      mockSocket._trigger('connect');

      // Dispatch auth:refreshed event
      const event = new Event('auth:refreshed');
      windowEventMock.dispatchEvent(event);

      // The connect function should have been called again with forceReconnect
      // Note: Since we're testing the store behavior, we verify the disconnect was called
      expect(mockSocket.disconnect).toHaveBeenCalled();
    });

    it('given socket not connected when auth:refreshed fires, should not attempt reconnect', async () => {
      const { connect } = useSocketStore.getState();
      await connect();

      // Socket is not connected
      mockSocket.connected = false;

      const disconnectCallCount = mockSocket.disconnect.mock.calls.length;

      // Dispatch auth:refreshed event
      const event = new Event('auth:refreshed');
      windowEventMock.dispatchEvent(event);

      // Should not have called disconnect again
      expect(mockSocket.disconnect.mock.calls.length).toBe(disconnectCallCount);
    });
  });

  describe('disconnect cleanup', () => {
    it('given disconnect() called, should remove auth:refreshed listener', async () => {
      const { connect, disconnect } = useSocketStore.getState();
      await connect();

      expect(windowEventMock.hasListener('auth:refreshed')).toBe(true);

      disconnect();

      expect(windowEventMock.removeEventListener).toHaveBeenCalledWith(
        'auth:refreshed',
        expect.any(Function)
      );
    });

    it('given disconnect() called, should set socket to null', async () => {
      const { connect, disconnect } = useSocketStore.getState();
      await connect();

      disconnect();

      const { socket } = useSocketStore.getState();
      expect(socket).toBeNull();
    });

    it('given disconnect() called, should set status to disconnected', async () => {
      const { connect, disconnect } = useSocketStore.getState();
      await connect();

      disconnect();

      const { connectionStatus } = useSocketStore.getState();
      expect(connectionStatus).toBe('disconnected');
    });
  });

  describe('force reconnect', () => {
    it('given connect(true) called while connected, should disconnect first', async () => {
      const { connect } = useSocketStore.getState();
      await connect();

      mockSocket.connected = true;

      // Force reconnect
      await connect(true);

      expect(mockSocket.disconnect).toHaveBeenCalled();
    });

    it('given connect(true) called, should create new socket', async () => {
      const { connect } = useSocketStore.getState();
      await connect();

      vi.mocked(io).mockClear();

      // Force reconnect
      await connect(true);

      expect(io).toHaveBeenCalled();
    });
  });

  describe('skip reconnect when already connected', () => {
    it('given already connected and not forcing, should return without creating new socket', async () => {
      const { connect } = useSocketStore.getState();
      await connect();

      mockSocket.connected = true;
      vi.mocked(io).mockClear();

      // Try to connect again without force
      await connect(false);

      expect(io).not.toHaveBeenCalled();
    });
  });
});
