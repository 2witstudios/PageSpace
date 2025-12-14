/**
 * Socket.IO Integration Tests
 * Tests for full connection lifecycle and event flows
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockSocket, createMockElectron, createWindowEventMock } from '../test/socket-mocks';

// Mock dependencies
const mockSocket = createMockSocket();
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocket),
}));

vi.mock('@/lib/utils/get-cookie-value', () => ({
  getCookieValue: vi.fn(() => 'valid-test-token'),
}));

vi.mock('@pagespace/lib/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn(() => ({
    'Content-Type': 'application/json',
    'X-Broadcast-Signature': 't=1234567890,v1=signature',
  })),
}));

vi.mock('@pagespace/lib/logger-browser', () => ({
  browserLoggers: {
    realtime: {
      child: vi.fn(() => ({
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    },
  },
}));

vi.mock('@pagespace/lib/utils/environment', () => ({
  isNodeEnvironment: vi.fn(() => true),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-4)}`),
}));

// Import after mocks
import { useSocketStore } from '../stores/socketStore';
import { io } from 'socket.io-client';
import { getCookieValue } from '@/lib/utils/get-cookie-value';
import { broadcastPageEvent, type PageEventPayload } from '@/lib/websocket';

describe('Socket.IO Integration', () => {
  const windowEventMock = createWindowEventMock();
  const originalWindow = { ...global.window };
  const originalFetch = global.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset store state
    useSocketStore.setState({
      socket: null,
      connectionStatus: 'disconnected',
      isInitialized: false,
    });

    // Reset mocks
    vi.clearAllMocks();
    mockSocket.connected = false;
    mockSocket.auth = {};
    mockSocket.io.opts.reconnection = true;
    mockSocket._handlers.clear();

    // Mock window
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

    // Set up environment
    process.env = {
      ...originalEnv,
      INTERNAL_REALTIME_URL: 'http://localhost:3001',
    };
  });

  afterEach(() => {
    Object.defineProperty(global, 'window', {
      value: originalWindow,
      writable: true,
    });
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  describe('connect → auth → rooms lifecycle', () => {
    it('given authenticated user, should connect, authenticate via token, and be ready for room joins', async () => {
      const mockToken = 'valid-jwt-token';
      vi.mocked(getCookieValue).mockReturnValue(mockToken);

      // Step 1: Connect
      const { connect } = useSocketStore.getState();
      await connect();

      // Verify socket created with auth token
      expect(io).toHaveBeenCalled();
      const callArgs = vi.mocked(io).mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        auth: { token: mockToken },
        withCredentials: true,
      });

      // Step 2: Simulate successful connection
      mockSocket._trigger('connect');

      // Verify status updated
      expect(useSocketStore.getState().connectionStatus).toBe('connected');

      // Step 3: Verify socket is available for room operations
      expect(useSocketStore.getState().socket).toBeTruthy();
      expect(useSocketStore.getState().isInitialized).toBe(true);

      // Verify auth:refreshed listener is registered
      expect(windowEventMock.hasListener('auth:refreshed')).toBe(true);
    });
  });

  describe('page event flow', () => {
    it('given page created, should broadcast to realtime server with correct channel', async () => {
      const payload: PageEventPayload = {
        driveId: 'drive-123',
        pageId: 'page-456',
        operation: 'created',
        title: 'New Page',
        type: 'DOCUMENT',
      };

      await broadcastPageEvent(payload);

      // Verify broadcast was sent
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/broadcast',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Broadcast-Signature': expect.any(String),
          }),
        })
      );

      // Verify channel routing
      const fetchCall = vi.mocked(global.fetch).mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1]?.body as string);
      expect(requestBody.channelId).toBe('drive:drive-123');
      expect(requestBody.event).toBe('page:created');
    });
  });

  describe('token refresh cycle', () => {
    it('given token expires, should refresh and reconnect seamlessly', async () => {
      vi.useFakeTimers();

      const { connect } = useSocketStore.getState();
      await connect();

      // Simulate auth error
      mockSocket._trigger('connect_error', new Error('Authentication error: Invalid token'));

      // Verify reconnection paused
      expect(mockSocket.io.opts.reconnection).toBe(false);

      // Mock successful refresh
      const newToken = 'refreshed-token';
      vi.mocked(getCookieValue).mockReturnValue(newToken);
      vi.mocked(global.fetch).mockResolvedValue({ ok: true } as Response);

      // Advance past refresh delay
      await vi.advanceTimersByTimeAsync(2100);

      // Verify token refresh was attempted
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/auth/refresh',
        expect.objectContaining({ method: 'POST', credentials: 'include' })
      );

      // Verify socket reconnected with new token
      expect(mockSocket.auth).toEqual({ token: newToken });
      expect(mockSocket.connect).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('logout cleanup', () => {
    it('given user logs out, should disconnect socket and cleanup all listeners', async () => {
      const { connect, disconnect } = useSocketStore.getState();
      await connect();

      mockSocket._trigger('connect');
      mockSocket.connected = true;

      // Verify connected state
      expect(useSocketStore.getState().connectionStatus).toBe('connected');
      expect(windowEventMock.hasListener('auth:refreshed')).toBe(true);

      // Logout (disconnect)
      disconnect();

      // Verify socket disconnected
      expect(mockSocket.disconnect).toHaveBeenCalled();

      // Verify auth:refreshed listener removed
      expect(windowEventMock.removeEventListener).toHaveBeenCalledWith(
        'auth:refreshed',
        expect.any(Function)
      );

      // Verify store state reset
      expect(useSocketStore.getState().socket).toBeNull();
      expect(useSocketStore.getState().connectionStatus).toBe('disconnected');
      expect(useSocketStore.getState().isInitialized).toBe(false);
    });
  });

  describe('multiple connection handling', () => {
    it('given already connected, should skip creating new socket unless forced', async () => {
      const { connect } = useSocketStore.getState();

      // Initial connection
      await connect();
      mockSocket.connected = true;

      vi.mocked(io).mockClear();

      // Try to connect again without force
      await connect(false);

      // Should not create new socket
      expect(io).not.toHaveBeenCalled();
    });

    it('given force reconnect, should disconnect and create new socket', async () => {
      const { connect } = useSocketStore.getState();

      // Initial connection
      await connect();
      mockSocket.connected = true;

      vi.mocked(io).mockClear();

      // Force reconnect
      await connect(true);

      // Should disconnect first
      expect(mockSocket.disconnect).toHaveBeenCalled();

      // Should create new socket
      expect(io).toHaveBeenCalled();
    });
  });

  describe('proactive reconnection', () => {
    it('given auth:refreshed event while connected, should force reconnect with new token', async () => {
      const { connect } = useSocketStore.getState();
      await connect();

      mockSocket.connected = true;
      mockSocket._trigger('connect');

      // Verify initial connection
      expect(useSocketStore.getState().connectionStatus).toBe('connected');

      // Simulate token refresh event
      const event = new Event('auth:refreshed');
      windowEventMock.dispatchEvent(event);

      // Should trigger disconnect for reconnect
      expect(mockSocket.disconnect).toHaveBeenCalled();
    });

    it('given auth:refreshed event while disconnected, should not attempt reconnect', async () => {
      const { connect } = useSocketStore.getState();
      await connect();

      // Socket not connected
      mockSocket.connected = false;

      const disconnectCallCount = mockSocket.disconnect.mock.calls.length;

      // Simulate token refresh event
      const event = new Event('auth:refreshed');
      windowEventMock.dispatchEvent(event);

      // Should not trigger additional disconnect
      expect(mockSocket.disconnect.mock.calls.length).toBe(disconnectCallCount);
    });
  });

  describe('desktop environment handling', () => {
    it('given Electron environment, should get token from secure storage', async () => {
      const mockToken = 'desktop-token';
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

      // Should use Electron auth
      expect(mockElectron.auth.getJWT).toHaveBeenCalled();

      // Should pass token to socket
      const callArgs = vi.mocked(io).mock.calls[0];
      expect(callArgs[1]).toMatchObject({
        auth: { token: mockToken },
      });
    });
  });

  describe('error state handling', () => {
    it('given connection error, should set error status', async () => {
      const { connect } = useSocketStore.getState();
      await connect();

      // Simulate connection error
      mockSocket._trigger('connect_error', new Error('Connection failed'));

      expect(useSocketStore.getState().connectionStatus).toBe('error');
    });

    it('given disconnect event, should set disconnected status', async () => {
      const { connect } = useSocketStore.getState();
      await connect();

      mockSocket._trigger('connect');
      expect(useSocketStore.getState().connectionStatus).toBe('connected');

      mockSocket._trigger('disconnect', 'io client disconnect');

      expect(useSocketStore.getState().connectionStatus).toBe('disconnected');
    });
  });
});
