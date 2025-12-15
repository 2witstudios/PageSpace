import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';

// Mock the websocket module
vi.mock('@/lib/websocket', () => ({
  getConnection: vi.fn(),
  checkConnectionHealth: vi.fn(),
}));

// Mock the logger
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

import { MCPBridge, getMCPBridge } from '../mcp-bridge';
import { getConnection, checkConnectionHealth } from '@/lib/websocket';

const mockGetConnection = vi.mocked(getConnection);
const mockCheckConnectionHealth = vi.mocked(checkConnectionHealth);

// Helper to create mock WebSocket
function createMockWebSocket(readyState: number = 1): Partial<WebSocket> {
  return {
    readyState: readyState as WebSocket['readyState'],
    send: vi.fn(),
    close: vi.fn(),
  };
}

describe('MCPBridge', () => {
  let bridge: MCPBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    bridge = new MCPBridge();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('executeTool', () => {
    it('throws error when user has no WebSocket connection', async () => {
      mockGetConnection.mockReturnValue(undefined);

      await expect(bridge.executeTool('user-123', 'server', 'tool')).rejects.toThrow(
        'Desktop app not connected. Please ensure PageSpace Desktop is running and connected.'
      );
    });

    it('throws error when WebSocket is not open', async () => {
      const mockWs = createMockWebSocket(3); // CLOSED state
      mockGetConnection.mockReturnValue(mockWs as WebSocket);

      await expect(bridge.executeTool('user-123', 'server', 'tool')).rejects.toThrow(
        'Desktop app not connected. Please ensure PageSpace Desktop is running and connected.'
      );
    });

    it('throws error when connection is unhealthy', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue({
        isHealthy: false,
        reason: 'Challenge verification not completed',
        readyState: 1,
        connectedDuration: 1000,
      });

      await expect(bridge.executeTool('user-123', 'server', 'tool')).rejects.toThrow(
        'Desktop connection unhealthy: Challenge verification not completed'
      );
    });

    it('sends tool execution request to WebSocket', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue({
        isHealthy: true,
        readyState: 1,
        connectedDuration: 1000,
      });

      // Start the request but don't await it yet
      const promise = bridge.executeTool('user-123', 'my-server', 'my-tool', { foo: 'bar' });

      // Verify send was called with correct payload
      const sentData = JSON.parse((mockWs.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(sentData.type).toBe('tool_execute');
      expect(sentData.serverName).toBe('my-server');
      expect(sentData.toolName).toBe('my-tool');
      expect(sentData.args).toEqual({ foo: 'bar' });
      expect(sentData.id).toBeDefined();

      // Simulate response
      bridge.handleToolResponse({
        type: 'tool_result',
        id: sentData.id,
        success: true,
        result: { output: 'success' },
      });

      const result = await promise;
      expect(result).toEqual({ output: 'success' });
    });

    it('rejects with error from tool execution response', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue({
        isHealthy: true,
        readyState: 1,
        connectedDuration: 1000,
      });

      const promise = bridge.executeTool('user-123', 'server', 'tool');

      const sentData = JSON.parse((mockWs.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);

      bridge.handleToolResponse({
        type: 'tool_result',
        id: sentData.id,
        success: false,
        error: 'Tool execution failed: invalid arguments',
      });

      await expect(promise).rejects.toThrow('Tool execution failed: invalid arguments');
    });

    it('rejects with default error when response has no error message', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue({
        isHealthy: true,
        readyState: 1,
        connectedDuration: 1000,
      });

      const promise = bridge.executeTool('user-123', 'server', 'tool');

      const sentData = JSON.parse((mockWs.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);

      bridge.handleToolResponse({
        type: 'tool_result',
        id: sentData.id,
        success: false,
      });

      await expect(promise).rejects.toThrow('Tool execution failed with unknown error');
    });

    it('times out after 30 seconds', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue({
        isHealthy: true,
        readyState: 1,
        connectedDuration: 1000,
      });

      const promise = bridge.executeTool('user-123', 'server', 'long-tool');

      // Fast forward 30 seconds
      vi.advanceTimersByTime(30000);

      await expect(promise).rejects.toThrow(
        'Tool execution timeout after 30000ms: server.long-tool'
      );
    });

    it('handles send failure gracefully', async () => {
      const mockWs = createMockWebSocket(1);
      (mockWs.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Send failed: connection reset');
      });
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue({
        isHealthy: true,
        readyState: 1,
        connectedDuration: 1000,
      });

      await expect(bridge.executeTool('user-123', 'server', 'tool')).rejects.toThrow(
        'Failed to send tool execution request: Send failed: connection reset'
      );
    });
  });

  describe('handleToolResponse', () => {
    it('ignores responses for unknown request IDs', () => {
      // This should not throw
      bridge.handleToolResponse({
        type: 'tool_result',
        id: 'unknown-request-id',
        success: true,
        result: { data: 'ignored' },
      });

      // Verify no pending requests exist
      expect(bridge.getPendingRequestCount()).toBe(0);
    });

    it('cleans up pending request after handling', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue({
        isHealthy: true,
        readyState: 1,
        connectedDuration: 1000,
      });

      const promise = bridge.executeTool('user-123', 'server', 'tool');

      expect(bridge.getPendingRequestCount()).toBe(1);

      const sentData = JSON.parse((mockWs.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      bridge.handleToolResponse({
        type: 'tool_result',
        id: sentData.id,
        success: true,
        result: {},
      });

      await promise;

      expect(bridge.getPendingRequestCount()).toBe(0);
    });
  });

  describe('isUserConnected', () => {
    it('returns true when user has active connection', () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);

      expect(bridge.isUserConnected('user-123')).toBe(true);
    });

    it('returns false when user has no connection', () => {
      mockGetConnection.mockReturnValue(undefined);

      expect(bridge.isUserConnected('user-123')).toBe(false);
    });

    it('returns false when connection is not open', () => {
      const mockWs = createMockWebSocket(3); // CLOSED
      mockGetConnection.mockReturnValue(mockWs as WebSocket);

      expect(bridge.isUserConnected('user-123')).toBe(false);
    });
  });

  describe('cancelUserRequests', () => {
    it('does not throw when user has no pending requests', () => {
      // This should not throw
      expect(() => bridge.cancelUserRequests('user-123')).not.toThrow();
    });

    it('logs cancellation message', () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue({
        isHealthy: true,
        readyState: 1,
        connectedDuration: 1000,
      });

      // Start a request
      bridge.executeTool('user-123', 'server', 'tool').catch(() => { });
      expect(bridge.getPendingRequestCount()).toBe(1);

      // Cancel should not throw
      expect(() => bridge.cancelUserRequests('user-123')).not.toThrow();

      // Clean up: advance timers to let promise timeout
      vi.advanceTimersByTime(30000);
    });
  });

  describe('getPendingRequestCount', () => {
    it('returns 0 when no requests pending', () => {
      expect(bridge.getPendingRequestCount()).toBe(0);
    });

    it('returns count of pending requests', async () => {
      const mockWs = createMockWebSocket(1);
      mockGetConnection.mockReturnValue(mockWs as WebSocket);
      mockCheckConnectionHealth.mockReturnValue({
        isHealthy: true,
        readyState: 1,
        connectedDuration: 1000,
      });

      // Start multiple requests without resolving them
      const p1 = bridge.executeTool('user-1', 'server', 'tool1');
      const p2 = bridge.executeTool('user-2', 'server', 'tool2');

      expect(bridge.getPendingRequestCount()).toBe(2);

      // Clean up: advance timers to let promises timeout
      vi.advanceTimersByTime(30000);
      await expect(p1).rejects.toThrow('timeout');
      await expect(p2).rejects.toThrow('timeout');
    });
  });
});

describe('getMCPBridge', () => {
  it('returns singleton instance', () => {
    const bridge1 = getMCPBridge();
    const bridge2 = getMCPBridge();

    expect(bridge1).toBe(bridge2);
  });

  it('returns MCPBridge instance', () => {
    const bridge = getMCPBridge();

    expect(bridge).toBeInstanceOf(MCPBridge);
  });
});
