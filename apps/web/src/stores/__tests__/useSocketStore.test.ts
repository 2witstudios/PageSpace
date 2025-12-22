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

// Mock getCookieValue
vi.mock('@/lib/utils/get-cookie-value', () => ({
  getCookieValue: vi.fn(() => null),
}));

// Import after mocks are set up
import { useSocketStore } from '../useSocketStore';
import { io } from 'socket.io-client';
import { getCookieValue } from '@/lib/utils/get-cookie-value';

describe('useSocketStore', () => {
  const windowEventMock = createWindowEventMock();
  const originalWindow = { ...global.window };
  const originalFetch = global.fetch;

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

    // Mock fetch
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
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
    it('given web environment with accessToken cookie, should extract token from cookie', async () => {
      const mockToken = 'web-test-token';
      vi.mocked(getCookieValue).mockReturnValue(mockToken);

      const { connect } = useSocketStore.getState();
      await connect();

      expect(getCookieValue).toHaveBeenCalledWith('accessToken');
      const callArgs = vi.mocked(io).mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        auth: { token: mockToken },
      });
    });

    it('given web environment without accessToken cookie, should pass undefined token', async () => {
      vi.mocked(getCookieValue).mockReturnValue(null);

      const { connect } = useSocketStore.getState();
      await connect();

      const callArgs = vi.mocked(io).mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        auth: { token: undefined },
      });
    });
  });

  describe('desktop token retrieval', () => {
    it('given Electron environment with stored JWT, should retrieve token from secure storage', async () => {
      const mockToken = 'desktop-test-token';
      const mockElectron = createMockElectron();
      mockElectron.auth.getJWT.mockResolvedValue(mockToken);

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

      expect(mockElectron.auth.getJWT).toHaveBeenCalled();
      const callArgs = vi.mocked(io).mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        auth: { token: mockToken },
      });
    });
  });

  describe('connection creation', () => {
    it('given valid token available, should create Socket.IO client with auth.token', async () => {
      const mockToken = 'test-token';
      vi.mocked(getCookieValue).mockReturnValue(mockToken);

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

    it('given Authentication error, should attempt token refresh after delay', async () => {
      vi.useFakeTimers();

      const { connect } = useSocketStore.getState();
      await connect();

      mockSocket._trigger('connect_error', new Error('Authentication error: Invalid token'));

      // Fast-forward past the 2 second delay
      await vi.advanceTimersByTimeAsync(2100);

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/auth/refresh',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
        })
      );

      vi.useRealTimers();
    });
  });

  describe('token refresh success', () => {
    it('given refresh endpoint returns 200, should update socket.auth with new token', async () => {
      vi.useFakeTimers();

      const newToken = 'refreshed-token';
      vi.mocked(getCookieValue).mockReturnValue(newToken);
      vi.mocked(global.fetch).mockResolvedValue({ ok: true } as Response);

      const { connect } = useSocketStore.getState();
      await connect();

      mockSocket._trigger('connect_error', new Error('Authentication error: Invalid token'));

      await vi.advanceTimersByTimeAsync(2100);

      expect(mockSocket.auth).toEqual({ token: newToken });
      expect(mockSocket.connect).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('token refresh failure', () => {
    it('given refresh endpoint returns error, should set status to error', async () => {
      vi.useFakeTimers();

      vi.mocked(global.fetch).mockResolvedValue({ ok: false } as Response);

      const { connect } = useSocketStore.getState();
      await connect();

      mockSocket._trigger('connect_error', new Error('Authentication error: Invalid token'));

      await vi.advanceTimersByTimeAsync(2100);

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
