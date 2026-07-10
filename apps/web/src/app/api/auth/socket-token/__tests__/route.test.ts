import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Contract tests for GET /api/auth/socket-token
 *
 * Creates short-lived tokens for Socket.IO authentication.
 *
 * Contract:
 *   Request: GET with valid session cookie
 *   Response:
 *     200: { token: string, expiresAt: string } with no-cache headers
 *     401: Unauthorized (plain text) when auth fails
 *
 * Dependencies mocked at service seam:
 *   - @/lib/auth/auth-helpers: requireAuth, isAuthError
 *   - @pagespace/lib/auth/session-service: sessionService.createSession (#1054 — unified
 *     opaque-token model, replaces the old sessionRepository.createSocketToken path)
 */

vi.mock('@/lib/auth/auth-helpers', () => ({
  requireAuth: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/security/client-ip', () => ({
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sock_mocktoken1234567890'),
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    security: {
      warn: vi.fn(),
    },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { GET } from '../route';

describe('/api/auth/socket-token', () => {
  const mockAuthUser = {
    userId: 'test-user-id',
    role: 'user' as const,
    sessionId: 'test-session-id',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T10:00:00.000Z'));

    // Default: authenticated user
    vi.mocked(requireAuth).mockResolvedValue(mockAuthUser as never);
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('successful token creation', () => {
    it('GET_withValidSession_returns200WithTokenAndExpiry', async () => {
      const request = new Request('http://localhost/api/auth/socket-token', {
        method: 'GET',
        headers: { Cookie: 'session=valid-token' },
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.token).toBe('ps_sock_mocktoken1234567890');
      expect(body.expiresAt).toBe(
        new Date(Date.now() + 5 * 60 * 1000).toISOString()
      );
    });

    it('GET_withValidSession_mintsSocketSessionViaSessionService', async () => {
      const request = new Request('http://localhost/api/auth/socket-token', {
        method: 'GET',
        headers: { Cookie: 'session=valid-token' },
      });

      await GET(request);

      expect(sessionService.createSession).toHaveBeenCalledTimes(1);
      expect(sessionService.createSession).toHaveBeenCalledWith({
        userId: 'test-user-id',
        type: 'socket',
        scopes: [],
        expiresInMs: 5 * 60 * 1000,
      });
    });

    it('GET_withValidSession_setsCacheControlHeaders', async () => {
      const request = new Request('http://localhost/api/auth/socket-token', {
        method: 'GET',
        headers: { Cookie: 'session=valid-token' },
      });

      const response = await GET(request);

      expect(response.headers.get('Cache-Control')).toBe(
        'no-store, no-cache, must-revalidate'
      );
      expect(response.headers.get('Vary')).toBe('Cookie');
    });

    it('GET_withValidSession_callsRequireAuth', async () => {
      const request = new Request('http://localhost/api/auth/socket-token', {
        method: 'GET',
        headers: { Cookie: 'session=valid-token' },
      });

      await GET(request);

      expect(requireAuth).toHaveBeenCalledWith(request);
    });
  });

  describe('authentication errors', () => {
    it('GET_withoutAuth_returns401', async () => {
      const unauthorizedResponse = new Response('Unauthorized', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      });
      vi.mocked(requireAuth).mockResolvedValue(unauthorizedResponse as never);
      vi.mocked(isAuthError).mockReturnValue(true);

      const request = new Request('http://localhost/api/auth/socket-token', {
        method: 'GET',
      });

      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('GET_withInvalidSession_returns401AndSkipsInsert', async () => {
      const unauthorizedResponse = new Response('Unauthorized', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      });
      vi.mocked(requireAuth).mockResolvedValue(unauthorizedResponse as never);
      vi.mocked(isAuthError).mockReturnValue(true);

      const request = new Request('http://localhost/api/auth/socket-token', {
        method: 'GET',
        headers: { Cookie: 'session=invalid-token' },
      });

      const response = await GET(request);

      expect(response.status).toBe(401);
      expect(sessionService.createSession).not.toHaveBeenCalled();
    });
  });
});
