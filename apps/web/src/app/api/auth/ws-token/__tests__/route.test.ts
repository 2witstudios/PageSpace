import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Contract tests for POST /api/auth/ws-token
 *
 * Creates long-lived WS tokens for desktop/mobile persistent connections.
 *
 * Contract:
 *   Request: POST with valid session (cookie or bearer)
 *   Response:
 *     200: { token: string }
 *     401: { error: 'Unauthorized' }
 *     429: { error: string, retryAfter: number } with Retry-After header
 *
 * Dependencies mocked at service seam:
 *   - @/lib/auth: verifyAuth, getClientIP
 *   - @pagespace/lib: sessionService.createSession
 *   - @pagespace/lib/security: checkDistributedRateLimit
 */

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_ws_token'),
  },
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    attemptsRemaining: 9,
  }),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { warn: vi.fn() },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

import { verifyAuth, getClientIP } from '@/lib/auth';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { POST } from '../route';

describe('/api/auth/ws-token', () => {
  const mockUser = {
    id: 'test-user-id',
    role: 'user' as const,
    tokenVersion: 1,
    adminRoleVersion: 0,
    authTransport: 'cookie' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user, rate limit allowed
    vi.mocked(verifyAuth).mockResolvedValue(mockUser);
    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: true,
      attemptsRemaining: 9,
    });
    vi.mocked(sessionService.createSession).mockResolvedValue('ps_sess_mock_ws_token');
  });

  describe('successful token creation', () => {
    it('POST_withValidSession_returns200WithToken', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/ws-token', {
        method: 'POST',
        headers: { Cookie: 'session=valid-token' },
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(200);
      expect(body).toEqual({ token: 'ps_sess_mock_ws_token' });
    });

    it('POST_withValidSession_createsSessionWithCorrectParams', async () => {
      // Arrange
      vi.mocked(getClientIP).mockReturnValue('192.168.1.100');

      const request = new Request('http://localhost/api/auth/ws-token', {
        method: 'POST',
        headers: {
          Cookie: 'session=valid-token',
          'x-forwarded-for': '192.168.1.100',
        },
      });

      // Act
      await POST(request);

      // Assert
      expect(sessionService.createSession).toHaveBeenCalledWith({
        userId: 'test-user-id',
        type: 'service',
        scopes: ['mcp:*'],
        expiresInMs: 90 * 24 * 60 * 60 * 1000,
        createdByService: 'desktop',
        createdByIp: '192.168.1.100',
      });
    });

    it('POST_withValidSession_checksRateLimitForUser', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/ws-token', {
        method: 'POST',
        headers: { Cookie: 'session=valid-token' },
      });

      // Act
      await POST(request);

      // Assert
      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'ws-token:user:test-user-id',
        { maxAttempts: 10, windowMs: 60000 }
      );
    });
  });

  describe('authentication errors (401)', () => {
    it('POST_withNoAuth_returns401', async () => {
      // Arrange
      vi.mocked(verifyAuth).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/ws-token', {
        method: 'POST',
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    it('POST_withInvalidSession_returns401AndSkipsRateLimit', async () => {
      // Arrange
      vi.mocked(verifyAuth).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/ws-token', {
        method: 'POST',
        headers: { Cookie: 'session=invalid-token' },
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(401);
      expect(checkDistributedRateLimit).not.toHaveBeenCalled();
      expect(sessionService.createSession).not.toHaveBeenCalled();
    });
  });

  describe('rate limiting (429)', () => {
    it('POST_whenRateLimited_returns429WithRetryAfter', async () => {
      // Arrange
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        retryAfter: 45,
      });

      const request = new Request('http://localhost/api/auth/ws-token', {
        method: 'POST',
        headers: { Cookie: 'session=valid-token' },
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(429);
      expect(body.error).toBe('Too many token requests. Please try again later.');
      expect(body.retryAfter).toBe(45);
      expect(response.headers.get('Retry-After')).toBe('45');
    });

    it('POST_whenRateLimitedWithNoRetryAfter_defaultsTo60', async () => {
      // Arrange
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        retryAfter: undefined,
      });

      const request = new Request('http://localhost/api/auth/ws-token', {
        method: 'POST',
        headers: { Cookie: 'session=valid-token' },
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('60');
    });

    it('POST_whenRateLimited_doesNotCreateSession', async () => {
      // Arrange
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        retryAfter: 30,
      });

      const request = new Request('http://localhost/api/auth/ws-token', {
        method: 'POST',
        headers: { Cookie: 'session=valid-token' },
      });

      // Act
      await POST(request);

      // Assert
      expect(sessionService.createSession).not.toHaveBeenCalled();
    });
  });
});
