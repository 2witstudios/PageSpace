import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';

vi.mock('@/lib/websocket', () => ({
  getConnection: vi.fn(),
  checkConnectionHealth: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

vi.mock('@pagespace/lib/security', () => ({
  validateLocalProviderURL: vi.fn(),
}));

import { FetchBridge, getFetchBridge } from '../fetch-bridge';
import { validateLocalProviderURL } from '@pagespace/lib/security';
import { getConnection, checkConnectionHealth } from '@/lib/websocket';

const mockGetConnection = vi.mocked(getConnection);
const mockCheckConnectionHealth = vi.mocked(checkConnectionHealth);
const mockValidateURL = vi.mocked(validateLocalProviderURL);

function createMockWebSocket(readyState: number = 1): Partial<WebSocket> {
  return {
    readyState: readyState as WebSocket['readyState'],
    send: vi.fn(),
    close: vi.fn(),
  };
}

function healthyConnection() {
  return { isHealthy: true, readyState: 1, connectedDuration: 1000 };
}

/** Flush microtask queue so async proxyFetch progresses past await */
const flushMicrotasks = () => vi.advanceTimersByTimeAsync(0);

/** Extract the request ID from the first message sent to the mock WebSocket */
function getSentRequestId(mockWs: Partial<WebSocket>): string {
  const sentData = JSON.parse((mockWs.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
  return sentData.id;
}

describe('FetchBridge', () => {
  let bridge: FetchBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    bridge = new FetchBridge();
    // Default: allow all local URLs (use mockReturnValue with Promise.resolve for sync resolution with fake timers)
    mockValidateURL.mockReturnValue(Promise.resolve({ valid: true, resolvedIPs: ['127.0.0.1'] }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('proxyFetch', () => {
    it('throws when user has no WebSocket connection', async () => {
      mockGetConnection.mockReturnValue(undefined);

      await expect(bridge.proxyFetch('user-1', 'http://localhost:11434/api/chat')).rejects.toThrow(
        'Desktop app not connected'
      );
    });

    it('throws when WebSocket is not open', async () => {
      const mockWs = createMockWebSocket(3);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);

      await expect(bridge.proxyFetch('user-1', 'http://localhost:11434/api/chat')).rejects.toThrow(
        'Desktop app not connected'
      );
    });

    it('throws when connection is unhealthy', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue({
        isHealthy: false,
        reason: 'Authentication not completed',
        readyState: 1,
        connectedDuration: 1000,
      });

      await expect(bridge.proxyFetch('user-1', 'http://localhost:11434/api/chat')).rejects.toThrow(
        'Desktop connection unhealthy: Authentication not completed'
      );
    });

    it('rejects non-local URLs to prevent open proxy abuse', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue(healthyConnection());
      mockValidateURL.mockReturnValue(Promise.resolve({ valid: false, error: 'Hostname blocked: evil.com' }));

      await expect(
        bridge.proxyFetch('user-1', 'https://evil.com/steal-data')
      ).rejects.toThrow('URL validation failed');

      // Should NOT have sent any message to the WebSocket
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('rejects cloud metadata URLs', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue(healthyConnection());
      mockValidateURL.mockReturnValue(Promise.resolve({ valid: false, error: 'IP address blocked: 169.254.169.254' }));

      await expect(
        bridge.proxyFetch('user-1', 'http://169.254.169.254/latest/meta-data/')
      ).rejects.toThrow('URL validation failed');

      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('sends fetch_request message via WebSocket and returns Response on success', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue(healthyConnection());

      const promise = bridge.proxyFetch('user-1', 'http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: btoa('{"model":"llama3"}'),
      });
      await flushMicrotasks();

      const sentData = JSON.parse((mockWs.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      const requestId = sentData.id;

      expect(sentData.type).toBe('fetch_request');
      expect(sentData.id).toBeDefined();
      expect(sentData.url).toBe('http://localhost:11434/api/chat');
      expect(sentData.method).toBe('POST');
      expect(sentData.headers).toEqual({ 'content-type': 'application/json' });

      bridge.handleResponseStart({
        type: 'fetch_response_start',
        id: requestId,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      });

      const response = await promise;
      expect(response.status).toBe(200);
      expect(response.statusText).toBe('OK');
      expect(response.headers.get('content-type')).toBe('application/json');

      bridge.handleResponseChunk({
        type: 'fetch_response_chunk',
        id: requestId,
        chunk: btoa('hello'),
      });

      bridge.handleResponseEnd({
        type: 'fetch_response_end',
        id: requestId,
      });

      const text = await response.text();
      expect(text).toBe('hello');
    });

    it('defaults method to GET and headers to empty', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue(healthyConnection());

      const promise = bridge.proxyFetch('user-1', 'http://localhost:11434/v1/models');
      await flushMicrotasks();

      const sentData = JSON.parse((mockWs.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      const requestId = sentData.id;
      expect(sentData.method).toBe('GET');
      expect(sentData.headers).toEqual({});
      expect(sentData.body).toBeUndefined();

      bridge.handleResponseStart({
        type: 'fetch_response_start',
        id: requestId,
        status: 200,
        statusText: 'OK',
        headers: {},
      });
      bridge.handleResponseEnd({ type: 'fetch_response_end', id: requestId });
      const response = await promise;
      expect(response.status).toBe(200);
    });

    it('rejects when send fails', async () => {
      const mockWs = createMockWebSocket(1);
      (mockWs.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Connection reset');
      });
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue(healthyConnection());

      await expect(bridge.proxyFetch('user-1', 'http://localhost:11434/api/chat')).rejects.toThrow(
        'Failed to send fetch request: Connection reset'
      );
    });

    it('times out after 120s overall even with active chunks', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue(healthyConnection());

      // Start request; we catch the rejection to avoid unhandled promise warnings
      const promise = bridge.proxyFetch('user-1', 'http://localhost:11434/api/chat').catch(() => {});
      await flushMicrotasks();
      const requestId = getSentRequestId(mockWs);

      // Send headers so the activity timeout resets on chunks
      bridge.handleResponseStart({
        type: 'fetch_response_start',
        id: requestId,
        status: 200,
        statusText: 'OK',
        headers: {},
      });

      // Keep sending chunks every 20s to prevent activity timeout
      for (let elapsed = 0; elapsed < 110_000; elapsed += 20_000) {
        vi.advanceTimersByTime(20_000);
        bridge.handleResponseChunk({
          type: 'fetch_response_chunk',
          id: requestId,
          chunk: btoa('data'),
        });
      }

      // This final advance pushes past 120s overall
      vi.advanceTimersByTime(20_000);
      await promise;

      // The overall timeout should have fired
      expect(bridge.getPendingRequestCount()).toBe(0);
    });

    it('times out after 30s of inactivity', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue(healthyConnection());

      const promise = bridge.proxyFetch('user-1', 'http://localhost:11434/api/chat');
      await flushMicrotasks();

      vi.advanceTimersByTime(30_000);

      await expect(promise).rejects.toThrow('Fetch activity timeout');
    });
  });

  describe('handleResponseStart', () => {
    it('ignores unknown request IDs', () => {
      expect(() =>
        bridge.handleResponseStart({
          type: 'fetch_response_start',
          id: 'unknown',
          status: 200,
          statusText: 'OK',
          headers: {},
        })
      ).not.toThrow();
    });
  });

  describe('handleResponseChunk', () => {
    it('resets activity timeout on each chunk', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue(healthyConnection());

      const promise = bridge.proxyFetch('user-1', 'http://localhost:11434/api/chat');
      await flushMicrotasks();
      const requestId = getSentRequestId(mockWs);

      bridge.handleResponseStart({
        type: 'fetch_response_start',
        id: requestId,
        status: 200,
        statusText: 'OK',
        headers: {},
      });

      const response = await promise;

      // Advance 20s, send chunk (resets timeout), advance 20s more — should still be alive
      vi.advanceTimersByTime(20_000);
      bridge.handleResponseChunk({
        type: 'fetch_response_chunk',
        id: requestId,
        chunk: btoa('chunk1'),
      });
      vi.advanceTimersByTime(20_000);
      bridge.handleResponseChunk({
        type: 'fetch_response_chunk',
        id: requestId,
        chunk: btoa('chunk2'),
      });

      bridge.handleResponseEnd({ type: 'fetch_response_end', id: requestId });

      const text = await response.text();
      expect(text).toBe('chunk1chunk2');
    });

    it('ignores unknown request IDs', () => {
      expect(() =>
        bridge.handleResponseChunk({
          type: 'fetch_response_chunk',
          id: 'unknown',
          chunk: btoa('data'),
        })
      ).not.toThrow();
    });
  });

  describe('handleResponseEnd', () => {
    it('closes stream and cleans up', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue(healthyConnection());

      const promise = bridge.proxyFetch('user-1', 'http://localhost:11434/api/chat');
      await flushMicrotasks();
      const requestId = getSentRequestId(mockWs);
      expect(bridge.getPendingRequestCount()).toBe(1);

      bridge.handleResponseStart({
        type: 'fetch_response_start',
        id: requestId,
        status: 200,
        statusText: 'OK',
        headers: {},
      });
      await promise;

      bridge.handleResponseEnd({ type: 'fetch_response_end', id: requestId });
      expect(bridge.getPendingRequestCount()).toBe(0);
    });

    it('ignores unknown request IDs', () => {
      expect(() =>
        bridge.handleResponseEnd({ type: 'fetch_response_end', id: 'unknown' })
      ).not.toThrow();
    });
  });

  describe('handleResponseError', () => {
    it('rejects the headers promise with the error', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue(healthyConnection());

      const promise = bridge.proxyFetch('user-1', 'http://localhost:11434/api/chat');
      await flushMicrotasks();
      const requestId = getSentRequestId(mockWs);

      bridge.handleResponseError({
        type: 'fetch_response_error',
        id: requestId,
        error: 'Connection refused',
      });

      await expect(promise).rejects.toThrow('Connection refused');
      expect(bridge.getPendingRequestCount()).toBe(0);
    });
  });

  describe('cancelUserRequests', () => {
    it('cancels all pending requests for a user', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue(healthyConnection());

      const promise = bridge.proxyFetch('user-1', 'http://localhost:11434/api/chat');
      await flushMicrotasks();

      bridge.cancelUserRequests('user-1');

      await expect(promise).rejects.toThrow('Desktop client disconnected');
      expect(bridge.getPendingRequestCount()).toBe(0);
    });

    it('does not throw for user with no requests', () => {
      expect(() => bridge.cancelUserRequests('no-such-user')).not.toThrow();
    });
  });

  describe('isUserConnected', () => {
    it('returns true when user has active connection', () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      expect(bridge.isUserConnected('user-1')).toBe(true);
    });

    it('returns false when no connection', () => {
      mockGetConnection.mockReturnValue(undefined);
      expect(bridge.isUserConnected('user-1')).toBe(false);
    });

    it('returns false when connection is closed', () => {
      const mockWs = createMockWebSocket(3);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      expect(bridge.isUserConnected('user-1')).toBe(false);
    });
  });

  describe('getPendingRequestCount', () => {
    it('returns 0 with no pending requests', () => {
      expect(bridge.getPendingRequestCount()).toBe(0);
    });
  });
});

describe('getFetchBridge', () => {
  it('returns singleton instance', () => {
    const a = getFetchBridge();
    const b = getFetchBridge();
    expect(a).toBe(b);
  });

  it('returns FetchBridge instance', () => {
    expect(getFetchBridge()).toBeInstanceOf(FetchBridge);
  });
});
