import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the client logger before importing auth-fetch
vi.mock('@/lib/logging/client-logger', () => ({
  createClientLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock the device fingerprint module for web refresh tests
vi.mock('@/lib/analytics/device-fingerprint', () => ({
  getOrCreateDeviceId: () => 'mock-device-id-12345',
}));

// Reset modules before each test to get fresh AuthFetch instance
beforeEach(() => {
  vi.resetModules();
});

describe('AuthFetch', () => {
  describe('refreshAuthSession queue drain', () => {
    let mockFetch: ReturnType<typeof vi.fn>;
    let originalFetch: typeof global.fetch;
    let originalWindow: typeof global.window;
    let originalLocalStorage: typeof global.localStorage;

    beforeEach(() => {
      // Save originals before modifying
      originalFetch = global.fetch;
      originalWindow = global.window;
      originalLocalStorage = global.localStorage;
      // Setup global fetch mock
      mockFetch = vi.fn();
      global.fetch = mockFetch;

      // Mock window and localStorage
      Object.defineProperty(global, 'window', {
        value: {
          dispatchEvent: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
        writable: true,
      });

      Object.defineProperty(global, 'localStorage', {
        value: {
          getItem: vi.fn().mockImplementation((key: string) => {
            // Return a mock device token for device refresh tests
            if (key === 'deviceToken') return 'mock-device-token-abc123';
            return null;
          }),
          setItem: vi.fn(),
          removeItem: vi.fn(),
        },
        writable: true,
      });

      // Clear any existing singleton
      const globalObj = globalThis as typeof globalThis & { [key: symbol]: unknown };
      const AUTHFETCH_KEY = Symbol.for('pagespace.authfetch.singleton');
      delete globalObj[AUTHFETCH_KEY];
    });

    afterEach(() => {
      vi.restoreAllMocks();
      global.fetch = originalFetch;
      Object.defineProperty(global, 'window', {
        value: originalWindow,
        writable: true,
      });
      Object.defineProperty(global, 'localStorage', {
        value: originalLocalStorage,
        writable: true,
      });
    });

    it('should process queued requests after successful refreshAuthSession', async () => {
      // Import fresh module
      const { AuthFetch } = await import('../auth-fetch');
      const authFetch = new AuthFetch();

      // Setup: Device token refresh succeeds (web session-based auth)
      mockFetch.mockImplementation(async (url: string) => {
        if (url === '/api/auth/device/refresh') {
          return new Response(JSON.stringify({
            deviceToken: 'new-device-token',
            csrfToken: 'new-csrf-token'
          }), { status: 200 });
        }
        // Subsequent API calls succeed
        return new Response(JSON.stringify({ data: 'test' }), { status: 200 });
      });

      // Access private members for testing
      const authFetchAny = authFetch as unknown as {
        isRefreshing: boolean;
        refreshQueue: Array<{
          resolve: (value: Response) => void;
          reject: (error: Error) => void;
          url: string;
          options?: RequestInit;
        }>;
        refreshPromise: Promise<{ success: boolean; shouldLogout: boolean }> | null;
        doRefresh: () => Promise<{ success: boolean; shouldLogout: boolean }>;
      };

      // Simulate a request being queued while refresh is in progress
      const queuedPromises: Promise<Response>[] = [];
      const resolvers: Array<(value: Response) => void> = [];
      const rejectors: Array<(error: Error) => void> = [];

      // Queue 2 requests
      for (let i = 0; i < 2; i++) {
        const promise = new Promise<Response>((resolve, reject) => {
          resolvers.push(resolve);
          rejectors.push(reject);
        });
        queuedPromises.push(promise);
        authFetchAny.refreshQueue.push({
          resolve: resolvers[i],
          reject: rejectors[i],
          url: `/api/test/${i}`,
          options: { method: 'GET' },
        });
      }

      expect(authFetchAny.refreshQueue.length).toBe(2);

      // Call refreshAuthSession which should drain the queue
      const result = await authFetch.refreshAuthSession();

      expect(result.success).toBe(true);
      expect(result.shouldLogout).toBe(false);

      // Queue should be empty after refresh
      expect(authFetchAny.refreshQueue.length).toBe(0);

      // Wait for queued requests to be processed
      await Promise.all(queuedPromises.map(p => p.catch(() => {})));

      // Verify fetch was called for queued requests
      const fetchCalls = mockFetch.mock.calls;
      expect(fetchCalls.some((call) => call[0] === '/api/test/0')).toBe(true);
      expect(fetchCalls.some((call) => call[0] === '/api/test/1')).toBe(true);
    });

    it('should reject queued requests after failed refreshAuthSession', async () => {
      // Import fresh module
      const { AuthFetch } = await import('../auth-fetch');
      const authFetch = new AuthFetch();

      // Setup: Device token refresh fails with 401 (invalid/expired device token)
      mockFetch.mockImplementation(async (url: string) => {
        if (url === '/api/auth/device/refresh') {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }
        return new Response(JSON.stringify({ data: 'test' }), { status: 200 });
      });

      // Access private members for testing
      const authFetchAny = authFetch as unknown as {
        refreshQueue: Array<{
          resolve: (value: Response) => void;
          reject: (error: Error) => void;
          url: string;
          options?: RequestInit;
        }>;
      };

      // Queue a request
      let resolvedValue: Response | null = null;
      let rejectedError: Error | null = null;

      const queuedPromise = new Promise<Response>((resolve, reject) => {
        authFetchAny.refreshQueue.push({
          resolve: (value) => {
            resolvedValue = value;
            resolve(value);
          },
          reject: (error) => {
            rejectedError = error;
            reject(error);
          },
          url: '/api/test/queued',
          options: { method: 'GET' },
        });
      });

      expect(authFetchAny.refreshQueue.length).toBe(1);

      // Call refreshAuthSession - it should fail and reject queued requests
      const result = await authFetch.refreshAuthSession();

      expect(result.success).toBe(false);
      expect(result.shouldLogout).toBe(true);

      // Queue should be empty after refresh
      expect(authFetchAny.refreshQueue.length).toBe(0);

      // Wait for queued promise to reject
      await expect(queuedPromise).rejects.toThrow('Authentication failed');
      expect(rejectedError).not.toBeNull();
      expect(rejectedError!.message).toBe('Authentication failed');
      expect(resolvedValue).toBeNull();
    });

    it('should handle empty queue gracefully', async () => {
      // Import fresh module
      const { AuthFetch } = await import('../auth-fetch');
      const authFetch = new AuthFetch();

      // Setup: Device token refresh succeeds
      mockFetch.mockImplementation(async (url: string) => {
        if (url === '/api/auth/device/refresh') {
          return new Response(JSON.stringify({
            deviceToken: 'new-device-token',
            csrfToken: 'new-csrf-token'
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: 'test' }), { status: 200 });
      });

      // Call refreshAuthSession with empty queue
      const result = await authFetch.refreshAuthSession();

      expect(result.success).toBe(true);
      expect(result.shouldLogout).toBe(false);

      // Should not throw any errors
    });

    it('should deduplicate concurrent refreshAuthSession calls', async () => {
      // Import fresh module
      const { AuthFetch } = await import('../auth-fetch');
      const authFetch = new AuthFetch();

      let refreshCallCount = 0;

      // Setup: Device token refresh succeeds but takes some time
      mockFetch.mockImplementation(async (url: string) => {
        if (url === '/api/auth/device/refresh') {
          refreshCallCount++;
          await new Promise(resolve => setTimeout(resolve, 50));
          return new Response(JSON.stringify({
            deviceToken: 'new-device-token',
            csrfToken: 'new-csrf-token'
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: 'test' }), { status: 200 });
      });

      // Call refreshAuthSession multiple times concurrently
      const results = await Promise.all([
        authFetch.refreshAuthSession(),
        authFetch.refreshAuthSession(),
        authFetch.refreshAuthSession(),
      ]);

      // All should succeed
      expect(results.every(r => r.success)).toBe(true);

      // But only one actual refresh should have been made
      expect(refreshCallCount).toBe(1);
    });
  });
});
