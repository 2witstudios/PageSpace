/**
 * Socket.IO Test Mocks
 * Utilities for testing socket-related functionality
 */

import { vi } from 'vitest';
import type { Socket } from 'socket.io-client';

type MockSocket = {
  connected: boolean;
  id: string;
  auth: Record<string, unknown>;
  io: { opts: { reconnection: boolean } };
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  // Event handlers storage for testing
  _handlers: Map<string, ((...args: unknown[]) => void)[]>;
  // Helper to trigger events in tests
  _trigger: (event: string, ...args: unknown[]) => void;
};

/**
 * Creates a mock Socket.IO client for testing
 */
export const createMockSocket = (): MockSocket => {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();

  const mockSocket: MockSocket = {
    connected: false,
    id: 'test-socket-id',
    auth: {},
    io: { opts: { reconnection: true } },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const existing = handlers.get(event) || [];
      handlers.set(event, [...existing, handler]);
      return mockSocket;
    }),
    off: vi.fn((event: string, handler?: (...args: unknown[]) => void) => {
      if (handler) {
        const existing = handlers.get(event) || [];
        handlers.set(event, existing.filter(h => h !== handler));
      } else {
        handlers.delete(event);
      }
      return mockSocket;
    }),
    connect: vi.fn(() => {
      mockSocket.connected = true;
      return mockSocket;
    }),
    disconnect: vi.fn(() => {
      mockSocket.connected = false;
      return mockSocket;
    }),
    emit: vi.fn(),
    _handlers: handlers,
    _trigger: (event: string, ...args: unknown[]) => {
      const eventHandlers = handlers.get(event) || [];
      eventHandlers.forEach(handler => handler(...args));
    },
  };

  return mockSocket;
};

/**
 * Creates a mock Electron API for desktop testing
 */
export const createMockElectron = () => ({
  auth: {
    getJWT: vi.fn().mockResolvedValue(null) as ReturnType<typeof vi.fn<() => Promise<string | null>>>,
    getSession: vi.fn().mockResolvedValue(null) as ReturnType<typeof vi.fn<() => Promise<{ deviceToken?: string } | null>>>,
    getDeviceInfo: vi.fn().mockResolvedValue({ deviceId: 'test-device-id' }) as ReturnType<typeof vi.fn<() => Promise<{ deviceId: string }>>>,
    storeSession: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn<() => Promise<void>>>,
  },
  on: vi.fn(),
});

/**
 * Creates a mock io() function for socket.io-client
 */
export const createMockIo = (mockSocket: MockSocket) => {
  return vi.fn(() => mockSocket as unknown as Socket);
};

/**
 * Mock window event listeners with tracking
 */
export const createWindowEventMock = () => {
  const listeners = new Map<string, Set<EventListener>>();

  const addEventListener = vi.fn((type: string, listener: EventListener) => {
    const existing = listeners.get(type) || new Set();
    existing.add(listener);
    listeners.set(type, existing);
  });

  const removeEventListener = vi.fn((type: string, listener: EventListener) => {
    const existing = listeners.get(type);
    if (existing) {
      existing.delete(listener);
    }
  });

  const dispatchEvent = vi.fn((event: Event) => {
    const eventListeners = listeners.get(event.type);
    if (eventListeners) {
      eventListeners.forEach(listener => listener(event));
    }
    return true;
  });

  return {
    addEventListener,
    removeEventListener,
    dispatchEvent,
    getListeners: (type: string) => listeners.get(type) || new Set(),
    hasListener: (type: string) => (listeners.get(type)?.size ?? 0) > 0,
  };
};

/**
 * Creates a mock fetch for token refresh endpoints
 */
export const createMockFetch = (responses: Record<string, { ok: boolean; json?: unknown }>) => {
  return vi.fn((url: string) => {
    const response = responses[url] || { ok: false };
    return Promise.resolve({
      ok: response.ok,
      json: () => Promise.resolve(response.json),
    });
  });
};
