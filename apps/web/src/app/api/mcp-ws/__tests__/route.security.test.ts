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
  getConnection: vi.fn(),
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

vi.mock('@/lib/fetch-bridge', () => ({
  isFetchBridgeInitialized: vi.fn(() => true),
  getFetchBridge: vi.fn(() => ({
    handleResponseStart: vi.fn(),
    handleResponseChunk: vi.fn(),
    handleResponseEnd: vi.fn(),
    handleResponseError: vi.fn(),
    cancelUserRequests: vi.fn(),
  })),
}));

vi.mock('@/lib/websocket/ws-security', () => ({
  getConnectionFingerprint: vi.fn(() => 'mock_fingerprint_hash_1234567890abcdef'),
  verifyFingerprint: vi.fn(() => true),
  validateMessageSize: vi.fn(() => ({ valid: true })),
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

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    security: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
  auditRequest: vi.fn(),
}));

import {
  registerConnection,
  verifyConnectionFingerprint,
  markChallengeVerified,
} from '@/lib/websocket';
import {
  getConnectionFingerprint,
  validateMessageSize,
} from '@/lib/websocket';
import { sessionService } from '@pagespace/lib';
import { auditRequest } from '@pagespace/lib/server';

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

      expect(registerConnection).toHaveBeenCalledWith('user_123', mockClient, 'mock_fingerprint_hash_1234567890abcdef', 'session_123', mockSessionExpiry, 'svc_mock_opaque_token_12345');
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
      expect(auditRequest).toHaveBeenCalledWith(
        mockRequest,
        expect.objectContaining({
          eventType: 'authz.access.denied',
          userId: 'user_123',
          resourceType: 'mcp_websocket',
          riskScore: 0.5,
          details: expect.objectContaining({
            originalEvent: 'ws_insufficient_permissions',
            scopes: ['read:pages'],
          }),
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

    it('should not leak sensitive data into audit events or console', async () => {
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

      const sensitivePattern = /password|secret|api[_-]?key|bearer|svc_mock_opaque_token|token(?!Version)/i;

      // Assert audit payloads do not carry raw token/secret values (these now
      // flow through auditRequest(), which is mocked — spying on console alone
      // would miss any regression that pipes raw credentials into audit details).
      const auditSerialized = vi
        .mocked(auditRequest)
        .mock.calls.map((call) => JSON.stringify(call[1]))
        .join(' ');
      expect(auditSerialized).not.toMatch(sensitivePattern);

      const allConsoleLogs = [
        ...consoleSpy.mock.calls.flat(),
        ...errorSpy.mock.calls.flat(),
      ].join(' ');
      expect(allConsoleLogs).not.toMatch(sensitivePattern);

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

      expect(typeof messageHandler).toBe('function');

      // Send a ping message to trigger fingerprint verification
      const pingMessage = JSON.stringify({ type: 'ping' });
      messageHandler!.call(mockClient, Buffer.from(pingMessage));

      expect(auditRequest).toHaveBeenCalledWith(
        mockRequest,
        expect.objectContaining({
          eventType: 'security.anomaly.detected',
          userId: 'user_123',
          resourceType: 'mcp_websocket',
          riskScore: 0.7,
          details: expect.objectContaining({
            originalEvent: 'ws_fingerprint_mismatch',
            reason: 'Connection fingerprint changed - possible session hijacking',
          }),
        })
      );

      expect(mockClient.close).toHaveBeenCalledWith(1008, 'Security violation');
    });
  });

  describe('A07 - Identification and Authentication Failures', () => {
    it('should audit authentication failures', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(null);

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      expect(auditRequest).toHaveBeenCalledWith(
        mockRequest,
        expect.objectContaining({
          eventType: 'auth.login.failure',
          resourceType: 'mcp_websocket',
          riskScore: 0.3,
          details: expect.objectContaining({
            originalEvent: 'ws_authentication_failed',
            reason: 'Invalid or expired session token',
          }),
        })
      );

      expect(mockClient.close).toHaveBeenCalledWith(1008, 'Invalid or expired token');
    });

    it('should audit session validation errors', async () => {
      vi.mocked(sessionService.validateSession).mockRejectedValue(new Error('Database error'));

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      expect(auditRequest).toHaveBeenCalledWith(
        mockRequest,
        expect.objectContaining({
          eventType: 'auth.login.failure',
          resourceType: 'mcp_websocket',
          riskScore: 0.3,
          details: expect.objectContaining({
            originalEvent: 'ws_session_validation_error',
            error: 'Database error',
          }),
        })
      );

      expect(mockClient.close).toHaveBeenCalledWith(1008, 'Authentication error');
    });
  });

  describe('A09 - Security Logging and Monitoring Failures', () => {
    it('should audit successful connections via audit pipeline', async () => {
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

      expect(auditRequest).toHaveBeenCalledWith(
        mockRequest,
        expect.objectContaining({
          eventType: 'auth.session.created',
          userId: 'user_123',
          sessionId: 'session_123',
          resourceType: 'mcp_websocket',
          riskScore: 0,
          details: expect.objectContaining({
            originalEvent: 'ws_connection_established',
          }),
        })
      );

      // Fingerprint must NOT be persisted in audit details (privacy: client-linkable
      // pseudonym that would resist GDPR erasure in the tamper-evident hash chain).
      const sessionAuditCall = vi.mocked(auditRequest).mock.calls.find(
        ([, event]) => event.eventType === 'auth.session.created'
      );
      expect(sessionAuditCall).toBeDefined();
      expect((sessionAuditCall![1].details ?? {}) as Record<string, unknown>).not.toHaveProperty('fingerprint');
    });

    it.each([1000, 1001])('should NOT audit normal disconnection (code %i)', async (closeCode) => {
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

      vi.mocked(auditRequest).mockClear();

      const closeHandler = vi.mocked(mockClient.on).mock.calls.find(
        (call) => call[0] === 'close'
      )?.[1];

      expect(typeof closeHandler).toBe('function');

      closeHandler!.call(mockClient, closeCode, Buffer.from('Normal closure'));

      const closeAuditCalls = vi.mocked(auditRequest).mock.calls.filter(
        ([, event]) =>
          (event as { details?: { originalEvent?: string } })?.details?.originalEvent ===
          'ws_connection_closed'
      );
      expect(closeAuditCalls).toHaveLength(0);
    });

    it('should audit abnormal disconnections (non-normal close codes)', async () => {
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

      expect(typeof closeHandler).toBe('function');

      closeHandler!.call(mockClient, 1006, Buffer.from('Abnormal closure'));

      expect(auditRequest).toHaveBeenCalledWith(
        mockRequest,
        expect.objectContaining({
          eventType: 'security.anomaly.detected',
          userId: 'user_123',
          resourceType: 'mcp_websocket',
          riskScore: 0.3,
          details: expect.objectContaining({
            originalEvent: 'ws_connection_closed',
            code: 1006,
            reason: 'Abnormal closure',
          }),
        })
      );
    });

    it('should only cancel user fetch requests once on close', async () => {
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

      const { getConnection } = await import('@/lib/websocket');
      vi.mocked(getConnection).mockReturnValue(mockClient);

      const { getFetchBridge, isFetchBridgeInitialized } = await import('@/lib/fetch-bridge');
      vi.mocked(isFetchBridgeInitialized).mockReturnValue(true);
      const cancelSpy = vi.fn();
      vi.mocked(getFetchBridge).mockReturnValue({
        handleResponseStart: vi.fn(),
        handleResponseChunk: vi.fn(),
        handleResponseEnd: vi.fn(),
        handleResponseError: vi.fn(),
        cancelUserRequests: cancelSpy,
      } as unknown as ReturnType<typeof getFetchBridge>);

      const { UPGRADE } = await import('../route');
      await UPGRADE(mockClient, mockServer, mockRequest);

      const closeHandler = vi.mocked(mockClient.on).mock.calls.find(
        (call) => call[0] === 'close'
      )?.[1];

      closeHandler!.call(mockClient, 1000, Buffer.from('Normal closure'));

      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Additional Security Controls', () => {
    it('should audit oversized messages', async () => {
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

      expect(typeof messageHandler).toBe('function');

      const largeMessage = JSON.stringify({ type: 'ping' });
      messageHandler!.call(mockClient, Buffer.from(largeMessage));

      expect(auditRequest).toHaveBeenCalledWith(
        mockRequest,
        expect.objectContaining({
          eventType: 'security.anomaly.detected',
          userId: 'user_123',
          resourceType: 'mcp_websocket',
          riskScore: 0.3,
          details: expect.objectContaining({
            originalEvent: 'ws_message_too_large',
            size: 10 * 1024 * 1024,
            maxSize: 1024 * 1024,
          }),
        })
      );

      expect(mockClient.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'error', error: 'message_too_large', maxSize: 1024 * 1024 })
      );
    });

    it('should audit malformed JSON messages', async () => {
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

      expect(typeof messageHandler).toBe('function');

      messageHandler!.call(mockClient, Buffer.from('{ invalid json'));

      expect(auditRequest).toHaveBeenCalledWith(
        mockRequest,
        expect.objectContaining({
          eventType: 'security.anomaly.detected',
          userId: 'user_123',
          resourceType: 'mcp_websocket',
          riskScore: 0.3,
          details: expect.objectContaining({
            originalEvent: 'ws_message_json_parse_error',
          }),
        })
      );

      expect(mockClient.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'error', error: 'invalid_json', reason: 'Message is not valid JSON' })
      );
    });

    it('should audit WebSocket errors', async () => {
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

      expect(typeof errorHandler).toBe('function');

      errorHandler!.call(mockClient, new Error('Test error'));

      expect(auditRequest).toHaveBeenCalledWith(
        mockRequest,
        expect.objectContaining({
          eventType: 'security.anomaly.detected',
          userId: 'user_123',
          resourceType: 'mcp_websocket',
          riskScore: 0.3,
          details: expect.objectContaining({
            originalEvent: 'ws_error',
            error: 'Test error',
          }),
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
