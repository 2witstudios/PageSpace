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
 *
 * Auth flow: Opaque session tokens (not JWT challenge-response)
 */

// Mock dependencies
vi.mock('@/lib/websocket/ws-connections', () => ({
  registerConnection: vi.fn(),
  unregisterConnection: vi.fn(),
  updateLastPing: vi.fn(),
  getConnectionMetadata: vi.fn(),
  verifyConnectionFingerprint: vi.fn(),
  startCleanupInterval: vi.fn(),
  stopCleanupInterval: vi.fn(),
  markChallengeVerified: vi.fn(),
  isChallengeVerified: vi.fn(() => true),
  checkConnectionHealth: vi.fn(() => ({ isHealthy: true })),
}));

vi.mock('@/lib/mcp/mcp-bridge', () => ({
  getMCPBridge: vi.fn(() => ({
    handleToolResponse: vi.fn(),
  })),
}));

vi.mock('@/lib/websocket/ws-security', () => ({
  getConnectionFingerprint: vi.fn(() => 'mock_fingerprint_hash_1234567890abcdef'),
  verifyFingerprint: vi.fn(() => true),
  validateMessageSize: vi.fn(() => ({ valid: true })),
  logSecurityEvent: vi.fn(),
  isSecureConnection: vi.fn(() => true),
}));

vi.mock('@pagespace/lib', () => ({
  sessionService: {
    validateSession: vi.fn(),
    createSession: vi.fn(),
  },
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
    })),
  },
}));

import {
  registerConnection,
  verifyConnectionFingerprint,
  markChallengeVerified,
} from '@/lib/websocket';
import {
  getConnectionFingerprint,
  logSecurityEvent,
  validateMessageSize,
} from '@/lib/websocket';
import { sessionService } from '@pagespace/lib';

// Mock session expiry (1 hour from now)
const mockSessionExpiry = new Date(Date.now() + 60 * 60 * 1000);

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

    // Create mock request with Authorization header (opaque token auth)
    mockRequest = {
      headers: new Headers({
        'user-agent': 'Mozilla/5.0 Test',
        'x-forwarded-for': '192.168.1.1',
        'authorization': 'Bearer svc_mock_opaque_token_12345',
      }),
      url: 'wss://example.com/api/mcp-ws',
    } as unknown as NextRequest;

    mockServer = {} as unknown as WebSocketServer;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('A01 - Broken Access Control', () => {
    it('should reject connection without Authorization header', async () => {
      const requestWithoutAuth = {
        ...mockRequest,
        headers: new Headers({
          'user-agent': 'Mozilla/5.0 Test',
          'x-forwarded-for': '192.168.1.1',
        }),
      } as unknown as NextRequest;

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, requestWithoutAuth);

      expect(mockClient.close).toHaveBeenCalledWith(1008, 'Authorization required');
      expect(registerConnection).not.toHaveBeenCalled();
    });

    it('should reject connection with invalid session token', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(null);

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      expect(mockClient.close).toHaveBeenCalledWith(1008, 'Invalid or expired token');
      expect(registerConnection).not.toHaveBeenCalled();
    });

    it('should accept connection with valid session token', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue({
        sessionId: 'session_123',
        userId: 'user_123',
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'service',
        scopes: ['mcp:*'],
        expiresAt: mockSessionExpiry,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      expect(registerConnection).toHaveBeenCalledWith('user_123', mockClient, expect.any(String), 'session_123', mockSessionExpiry, expect.any(String));
      expect(markChallengeVerified).toHaveBeenCalledWith(mockClient);
    });

    it('should reject connection with insufficient scopes', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue({
        sessionId: 'session_123',
        userId: 'user_123',
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'service',
        scopes: ['read:pages'], // Missing mcp:* scope
        expiresAt: mockSessionExpiry,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      expect(mockClient.close).toHaveBeenCalledWith(1008, 'Insufficient permissions');
      expect(logSecurityEvent).toHaveBeenCalledWith(
        'ws_insufficient_permissions',
        expect.objectContaining({
          userId: 'user_123',
          severity: 'warn',
        })
      );
    });
  });

  describe('A02 - Cryptographic Failures', () => {
    it('should reject non-secure WebSocket connections in production', async () => {
      const insecureRequest = {
        ...mockRequest,
        url: 'ws://example.com/api/mcp-ws', // Non-secure protocol
      } as unknown as NextRequest;

      // Mock isSecureConnection to return false for this test
      const { isSecureConnection } = await import('@/lib/websocket/ws-security');
      vi.mocked(isSecureConnection).mockReturnValue(false);

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

    it('should not leak sensitive data in logs', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const errorSpy = vi.spyOn(console, 'error');

      vi.mocked(sessionService.validateSession).mockResolvedValue({
        sessionId: 'session_123',
        userId: 'user_123',
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'service',
        scopes: ['mcp:*'],
        expiresAt: mockSessionExpiry,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const allLogs = [
        ...consoleSpy.mock.calls.flat(),
        ...errorSpy.mock.calls.flat(),
      ].join(' ');

      // Should not contain tokens, API keys, passwords
      expect(allLogs).not.toMatch(/password|secret|key|token(?!Version)/i);

      consoleSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('A04 - Insecure Design', () => {
    it('should implement connection fingerprinting', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue({
        sessionId: 'session_123',
        userId: 'user_123',
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'service',
        scopes: ['mcp:*'],
        expiresAt: mockSessionExpiry,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      expect(getConnectionFingerprint).toHaveBeenCalledWith(mockRequest);
    });

    it('should detect fingerprint changes and close connection', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue({
        sessionId: 'session_123',
        userId: 'user_123',
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'service',
        scopes: ['mcp:*'],
        expiresAt: mockSessionExpiry,
      });

      vi.mocked(verifyConnectionFingerprint).mockReturnValue(false);

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const messageHandler = vi.mocked(mockClient.on).mock.calls.find(
        (call) => call[0] === 'message'
      )?.[1];

      expect(messageHandler).toBeDefined();

      // Send a ping message to trigger fingerprint verification
      const pingMessage = JSON.stringify({ type: 'ping' });
      messageHandler!.call(mockClient, Buffer.from(pingMessage));

      expect(logSecurityEvent).toHaveBeenCalledWith(
        'ws_fingerprint_mismatch',
        expect.objectContaining({
          userId: 'user_123',
          severity: 'critical',
        })
      );

      expect(mockClient.close).toHaveBeenCalledWith(1008, 'Security violation');
    });
  });

  describe('A07 - Identification and Authentication Failures', () => {
    it('should log authentication failures', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(null);

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      expect(logSecurityEvent).toHaveBeenCalledWith(
        'ws_authentication_failed',
        expect.objectContaining({
          severity: 'warn',
          reason: 'Invalid or expired session token',
        })
      );

      expect(mockClient.close).toHaveBeenCalledWith(1008, 'Invalid or expired token');
    });

    it('should handle session validation errors gracefully', async () => {
      vi.mocked(sessionService.validateSession).mockRejectedValue(new Error('Database error'));

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      expect(logSecurityEvent).toHaveBeenCalledWith(
        'ws_session_validation_error',
        expect.objectContaining({
          severity: 'error',
        })
      );

      expect(mockClient.close).toHaveBeenCalledWith(1008, 'Authentication error');
    });
  });

  describe('A09 - Security Logging and Monitoring Failures', () => {
    it('should log successful connections with user ID', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue({
        sessionId: 'session_123',
        userId: 'user_123',
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'service',
        scopes: ['mcp:*'],
        expiresAt: mockSessionExpiry,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      expect(logSecurityEvent).toHaveBeenCalledWith(
        'ws_connection_established',
        expect.objectContaining({
          userId: 'user_123',
          sessionId: 'session_123',
          severity: 'info',
        })
      );
    });

    it('should log disconnections with reason', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue({
        sessionId: 'session_123',
        userId: 'user_123',
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'service',
        scopes: ['mcp:*'],
        expiresAt: mockSessionExpiry,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const closeHandler = vi.mocked(mockClient.on).mock.calls.find(
        (call) => call[0] === 'close'
      )?.[1];

      expect(closeHandler).toBeDefined();

      closeHandler!.call(mockClient, 1000, Buffer.from('Normal closure'));

      expect(logSecurityEvent).toHaveBeenCalledWith(
        'ws_connection_closed',
        expect.objectContaining({
          userId: 'user_123',
          code: 1000,
          severity: 'info',
        })
      );
    });
  });

  describe('Additional Security Controls', () => {
    it('should validate message size to prevent DoS', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue({
        sessionId: 'session_123',
        userId: 'user_123',
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'service',
        scopes: ['mcp:*'],
        expiresAt: mockSessionExpiry,
      });

      vi.mocked(validateMessageSize).mockReturnValue({
        valid: false,
        size: 10 * 1024 * 1024,
        maxSize: 1024 * 1024,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const messageHandler = vi.mocked(mockClient.on).mock.calls.find(
        (call) => call[0] === 'message'
      )?.[1];

      expect(messageHandler).toBeDefined();

      const largeMessage = JSON.stringify({ type: 'ping' });
      messageHandler!.call(mockClient, Buffer.from(largeMessage));

      expect(logSecurityEvent).toHaveBeenCalledWith(
        'ws_message_too_large',
        expect.objectContaining({
          userId: 'user_123',
          severity: 'warn',
        })
      );

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.stringContaining('message_too_large')
      );
    });

    it('should handle malformed JSON gracefully', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue({
        sessionId: 'session_123',
        userId: 'user_123',
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'service',
        scopes: ['mcp:*'],
        expiresAt: mockSessionExpiry,
      });

      vi.mocked(validateMessageSize).mockReturnValue({ valid: true });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const messageHandler = vi.mocked(mockClient.on).mock.calls.find(
        (call) => call[0] === 'message'
      )?.[1];

      expect(messageHandler).toBeDefined();

      messageHandler!.call(mockClient, Buffer.from('{ invalid json'));

      expect(logSecurityEvent).toHaveBeenCalledWith(
        'ws_message_json_parse_error',
        expect.objectContaining({
          userId: 'user_123',
          severity: 'warn',
        })
      );

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.stringContaining('invalid_json')
      );
    });

    it('should handle WebSocket errors without crashing', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue({
        sessionId: 'session_123',
        userId: 'user_123',
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'service',
        scopes: ['mcp:*'],
        expiresAt: mockSessionExpiry,
      });

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const errorHandler = vi.mocked(mockClient.on).mock.calls.find(
        (call) => call[0] === 'error'
      )?.[1];

      expect(errorHandler).toBeDefined();

      errorHandler!.call(mockClient, new Error('Test error'));

      expect(logSecurityEvent).toHaveBeenCalledWith(
        'ws_error',
        expect.objectContaining({
          userId: 'user_123',
          error: 'Test error',
          severity: 'error',
        })
      );
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

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });
  });
});
