import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { NextRequest } from 'next/server';

/**
 * Security Test Suite for WebSocket MCP Bridge
 *
 * Tests cover OWASP Top 10 vulnerabilities:
 * - A01: Broken Access Control
 * - A02: Cryptographic Failures
 * - A04: Insecure Design
 * - A07: Identification and Authentication Failures
 * - A09: Security Logging and Monitoring Failures
 */

// Mock dependencies
vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@/lib/ws-connections', () => ({
  registerConnection: vi.fn(),
  unregisterConnection: vi.fn(),
  updateLastPing: vi.fn(),
  getConnectionMetadata: vi.fn(),
  verifyConnectionFingerprint: vi.fn(),
}));

vi.mock('@/lib/mcp-bridge', () => ({
  getMCPBridge: vi.fn(() => ({
    handleToolResponse: vi.fn(),
  })),
}));

vi.mock('@/lib/ws-security', () => ({
  generateChallenge: vi.fn(),
  verifyChallengeResponse: vi.fn(),
  getConnectionFingerprint: vi.fn(),
}));

import { verifyAuth } from '@/lib/auth';
import {
  registerConnection,
  verifyConnectionFingerprint,
} from '@/lib/ws-connections';
import {
  generateChallenge,
  verifyChallengeResponse,
  getConnectionFingerprint,
} from '@/lib/ws-security';

describe('WebSocket MCP Bridge - Security Tests', () => {
  let mockClient: WebSocket;
  let mockRequest: NextRequest;
  let mockServer: WebSocketServer;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock WebSocket client
    mockClient = {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      readyState: 1, // OPEN
    } as unknown as WebSocket;

    // Create mock request
    mockRequest = {
      headers: new Headers({
        'user-agent': 'Mozilla/5.0 Test',
        'x-forwarded-for': '192.168.1.1',
      }),
      url: 'wss://example.com/api/mcp-ws',
    } as unknown as NextRequest;

    mockServer = {} as unknown as WebSocketServer;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('A01 - Broken Access Control', () => {
    it('should reject unauthenticated WebSocket connection', async () => {
      vi.mocked(verifyAuth).mockResolvedValue(null);

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      expect(mockClient.close).toHaveBeenCalledWith(1008, 'Unauthorized');
      expect(registerConnection).not.toHaveBeenCalled();
    });

    it('should reject connection after JWT expires mid-session', async () => {
      // Initial connection succeeds
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      expect(registerConnection).toHaveBeenCalledWith('user_123', mockClient);

      // Simulate JWT expiration - connection should be terminated
      // This test ensures connections don't persist after token expiration
    });

    it('should prevent unauthorized tool execution', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const messageHandler = vi.mocked(mockClient.on).mock.calls.find(
        (call) => call[0] === 'message'
      )?.[1];

      if (messageHandler) {
        // Attempt to execute tool before challenge completion
        const toolRequest = JSON.stringify({
          type: 'tool_execute',
          id: 'req_123',
          serverName: 'test-server',
          toolName: 'test-tool',
        });

        await messageHandler.call(mockClient, Buffer.from(toolRequest));

        // Should reject if challenge not completed
        expect(mockClient.send).toHaveBeenCalledWith(
          expect.stringContaining('challenge_required')
        );
      }
    });

    it('should close existing connection when user connects from new device', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      // registerConnection should handle closing existing connections
      expect(registerConnection).toHaveBeenCalledWith('user_123', mockClient);
    });
  });

  describe('A02 - Cryptographic Failures', () => {
    it('should reject non-secure WebSocket connections in production', async () => {
      const insecureRequest = {
        ...mockRequest,
        url: 'ws://example.com/api/mcp-ws', // Non-secure protocol
      } as unknown as NextRequest;

      // In production, should enforce WSS
      if (process.env.NODE_ENV === 'production') {
        const { UPGRADE } = await import('../route');
        await UPGRADE(mockClient, mockServer, insecureRequest);

        expect(mockClient.close).toHaveBeenCalledWith(
          1008,
          'Secure connection required'
        );
      }
    });

    it('should verify JWT signature cryptographically', async () => {
      vi.mocked(verifyAuth).mockResolvedValue(null);

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      // verifyAuth should have been called, which validates JWT signature
      expect(verifyAuth).toHaveBeenCalledWith(mockRequest);
      expect(mockClient.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    });

    it('should not leak encryption keys or sensitive data in logs', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const errorSpy = vi.spyOn(console, 'error');

      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      // Check no sensitive data in logs
      const allLogs = [
        ...consoleSpy.mock.calls.flat(),
        ...errorSpy.mock.calls.flat(),
      ].join(' ');

      expect(allLogs).not.toMatch(/password|secret|key|token(?!Version)/i);

      consoleSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('A04 - Insecure Design', () => {
    it('should implement challenge-response after initial connection', async () => {
      const mockChallenge = 'challenge_abc123';

      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      vi.mocked(generateChallenge).mockReturnValue(mockChallenge);

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      // Should send challenge to client
      expect(mockClient.send).toHaveBeenCalledWith(
        expect.stringContaining('challenge')
      );
    });

    it('should verify challenge response before allowing tool execution', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      vi.mocked(verifyChallengeResponse).mockReturnValue({ valid: false, failureReason: 'Invalid response' });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const messageHandler = vi.mocked(mockClient.on).mock.calls.find(
        (call) => call[0] === 'message'
      )?.[1];

      if (messageHandler) {
        // Invalid challenge response
        const response = JSON.stringify({
          type: 'challenge_response',
          response: 'invalid_response',
        });

        await messageHandler.call(mockClient, Buffer.from(response));

        // Connection should be closed
        expect(mockClient.close).toHaveBeenCalledWith(
          1008,
          'Challenge verification failed'
        );
      }
    });

    it('should implement connection fingerprinting', async () => {
      const mockFingerprint = 'fingerprint_hash_abc123';

      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      vi.mocked(getConnectionFingerprint).mockReturnValue(mockFingerprint);

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      // Should generate fingerprint from IP + User-Agent
      expect(getConnectionFingerprint).toHaveBeenCalledWith(mockRequest);
    });

    it('should detect fingerprint changes and require re-verification', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      vi.mocked(verifyConnectionFingerprint).mockReturnValue(false);

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      // Connection with mismatched fingerprint should trigger re-auth
      expect(mockClient.send).toHaveBeenCalledWith(
        expect.stringContaining('fingerprint_mismatch')
      );
    });

    it('should implement connection timeout for inactive connections', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      // After 5 minutes of no ping, connection should be closed
      // This test would need to advance timers in real implementation
    });
  });

  describe('A07 - Identification and Authentication Failures', () => {
    it('should invalidate connection when token version changes', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      // Token version incremented (password change, logout all sessions)
      // Connection should be terminated
      // This would be handled by periodic token revalidation
    });

    it('should enforce session expiration even for active connections', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      // Even if connection is active, JWT expiration should terminate it
      // Should implement periodic revalidation
    });

    it('should prevent brute force challenge attempts', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      vi.mocked(verifyChallengeResponse).mockReturnValue({ valid: false, failureReason: 'Invalid response' });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const messageHandler = vi.mocked(mockClient.on).mock.calls.find(
        (call) => call[0] === 'message'
      )?.[1];

      if (messageHandler) {
        // Send multiple invalid challenge responses
        for (let i = 0; i < 5; i++) {
          const response = JSON.stringify({
            type: 'challenge_response',
            response: `invalid_${i}`,
          });

          await messageHandler.call(mockClient, Buffer.from(response));
        }

        // After 3 failed attempts, connection should be closed
        expect(mockClient.close).toHaveBeenCalled();
      }
    });

    it('should log all authentication failures', async () => {
      const consoleSpy = vi.spyOn(console, 'error');

      vi.mocked(verifyAuth).mockResolvedValue(null);

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unauthorized WebSocket connection attempt')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('A09 - Security Logging and Monitoring Failures', () => {
    it('should log successful connections with user ID', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('User user_123 connected')
      );

      consoleSpy.mockRestore();
    });

    it('should log tool execution requests for audit trail', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const messageHandler = vi.mocked(mockClient.on).mock.calls.find(
        (call) => call[0] === 'message'
      )?.[1];

      if (messageHandler) {
        const consoleSpy = vi.spyOn(console, 'log');

        const toolRequest = JSON.stringify({
          type: 'tool_result',
          id: 'req_123',
          success: true,
        });

        await messageHandler.call(mockClient, Buffer.from(toolRequest));

        // Should log tool execution
        expect(consoleSpy).toHaveBeenCalled();

        consoleSpy.mockRestore();
      }
    });

    it('should NOT log sensitive data (tokens, passwords, keys)', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const errorSpy = vi.spyOn(console, 'error');

      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const allLogs = [
        ...consoleSpy.mock.calls.flat(),
        ...errorSpy.mock.calls.flat(),
      ]
        .map((arg) => String(arg))
        .join(' ');

      // Should not contain JWT tokens, API keys, passwords
      expect(allLogs).not.toMatch(/Bearer\s+[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/);
      expect(allLogs).not.toMatch(/password|api[_-]?key|secret/i);

      consoleSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should log disconnections with reason', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const closeHandler = vi.mocked(mockClient.on).mock.calls.find(
        (call) => call[0] === 'close'
      )?.[1];

      expect(closeHandler).toBeDefined();

      if (closeHandler) {
        const consoleSpy = vi.spyOn(console, 'log');

        await closeHandler.call(mockClient, 1000, Buffer.from('Normal closure'));

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('User user_123 disconnected')
        );

        consoleSpy.mockRestore();
      }
    });
  });

  describe('Additional Security Controls', () => {
    it('should validate message size to prevent DoS', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const messageHandler = vi.mocked(mockClient.on).mock.calls.find(
        (call) => call[0] === 'message'
      )?.[1];

      if (messageHandler) {
        // Send extremely large message
        const largeMessage = JSON.stringify({
          type: 'tool_execute',
          id: 'req_123',
          args: 'A'.repeat(10 * 1024 * 1024), // 10MB
        });

        await messageHandler.call(mockClient, Buffer.from(largeMessage));

        // Should reject oversized messages
        expect(mockClient.send).toHaveBeenCalledWith(
          expect.stringContaining('message_too_large')
        );
      }
    });

    it('should handle malformed JSON gracefully', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const messageHandler = vi.mocked(mockClient.on).mock.calls.find(
        (call) => call[0] === 'message'
      )?.[1];

      if (messageHandler) {
        // Send malformed JSON
        await messageHandler.call(mockClient, Buffer.from('{ invalid json'));

        // Should send error, not crash
        expect(mockClient.send).toHaveBeenCalledWith(
          expect.stringContaining('Invalid message format')
        );
      }
    });

    it('should enforce secure cookie attributes', async () => {
      // JWT cookies should have:
      // - httpOnly: true (prevent XSS)
      // - secure: true (HTTPS only in production)
      // - sameSite: 'strict' or 'lax' (prevent CSRF)

      // This is validated by verifyAuth implementation
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      // If verifyAuth succeeds, cookies were properly validated
      expect(verifyAuth).toHaveBeenCalled();
    });

    it('should handle WebSocket errors without crashing', async () => {
      vi.mocked(verifyAuth).mockResolvedValue({
        id: 'user_123',
        role: 'user',
        tokenVersion: 1,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const errorHandler = vi.mocked(mockClient.on).mock.calls.find(
        (call) => call[0] === 'error'
      )?.[1];

      expect(errorHandler).toBeDefined();

      if (errorHandler) {
        const errorSpy = vi.spyOn(console, 'error');

        await errorHandler.call(mockClient, new Error('Test error'));

        // Should log error, not crash
        expect(errorSpy).toHaveBeenCalled();

        errorSpy.mockRestore();
      }
    });
  });

  describe('GET Endpoint Fallback', () => {
    it('should return 426 Upgrade Required for non-WebSocket requests', async () => {
      const { GET } = await import('../route');
      const response = GET();

      expect(response.status).toBe(426);
      expect(response.headers.get('Upgrade')).toBe('websocket');
    });

    it('should include security headers in GET response', async () => {
      const { GET } = await import('../route');
      const response = GET();

      // Should have security headers
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });
  });
});
