/**
 * Contract tests for POST /api/auth/logout
 *
 * These tests verify the Request → Response contract for user logout.
 * Uses session-based authentication with opaque tokens.
 *
 * Coverage:
 * - Session revocation
 * - Cookie clearing
 * - Logging
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '../logout/route';

// Mock session service from @pagespace/lib/auth
vi.mock('@pagespace/lib/auth', () => ({
  sessionService: {
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'test-session-id',
      userId: 'test-user-id',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
    }),
    revokeSession: vi.fn().mockResolvedValue(undefined),
    revokeAllUserSessions: vi.fn().mockResolvedValue(0),
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_session_token'),
  },
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
}));

// Mock cookie utilities
vi.mock('@/lib/auth/cookie-config', () => ({
  getSessionFromCookies: vi.fn().mockReturnValue('ps_sess_mock_session_token'),
  appendSessionCookie: vi.fn(),
  appendClearCookies: vi.fn(),
}));

// Mock client IP extraction
vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('unknown'),
}));

vi.mock('@pagespace/lib/server', () => ({
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
  logAuthEvent: vi.fn(),
  securityAudit: {
    logLogout: vi.fn().mockResolvedValue(undefined),
    logTokenRevoked: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

import { sessionService } from '@pagespace/lib/auth';
import { getSessionFromCookies, appendClearCookies } from '@/lib/auth/cookie-config';
import { getClientIP } from '@/lib/auth';
import { loggers, logAuthEvent, securityAudit } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

describe('/api/auth/logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: valid session
    vi.mocked(getSessionFromCookies).mockReturnValue('ps_sess_mock_session_token');
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      sessionId: 'test-session-id',
      userId: 'test-user-id',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
    } as never);
    vi.mocked(getClientIP).mockReturnValue('unknown');
  });

  describe('successful logout', () => {
    it('returns 200 on successful logout', async () => {
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'session=ps_sess_mock_session_token',
        },
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');
    });

    it('revokes session on logout', async () => {
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'session=ps_sess_mock_session_token',
        },
      });

      await POST(request);

      expect(sessionService.revokeSession).toHaveBeenCalledWith(
        'ps_sess_mock_session_token',
        'logout'
      );
    });

    it('clears cookies on logout', async () => {
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'session=ps_sess_mock_session_token',
        },
      });

      await POST(request);

      expect(appendClearCookies).toHaveBeenCalledTimes(1);
      expect(vi.mocked(appendClearCookies).mock.calls[0][0]).toBeInstanceOf(Headers);
    });

    it('logs logout event', async () => {
      vi.mocked(getClientIP).mockReturnValue('192.168.1.1');

      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'session=ps_sess_mock_session_token',
          'x-forwarded-for': '192.168.1.1',
        },
      });

      await POST(request);

      expect(logAuthEvent).toHaveBeenCalledWith(
        'logout',
        'test-user-id',
        undefined,
        '192.168.1.1'
      );
      expect(trackAuthEvent).toHaveBeenCalledWith(
        'test-user-id',
        'logout',
        {
          ip: '192.168.1.1',
          userAgent: null,
        }
      );
    });
  });

  describe('edge cases', () => {
    it('handles missing session cookie gracefully', async () => {
      vi.mocked(getSessionFromCookies).mockReturnValue(null);

      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const response = await POST(request);
      const body = await response.json();

      // Logout should still succeed even without session
      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');
      // Session revoke should not be called since there's no session
      expect(sessionService.revokeSession).not.toHaveBeenCalled();
      // But cookies should still be cleared
      expect(appendClearCookies).toHaveBeenCalledTimes(1);
      expect(vi.mocked(appendClearCookies).mock.calls[0][0]).toBeInstanceOf(Headers);
    });

    it('handles invalid session gracefully', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(null);
      vi.mocked(getSessionFromCookies).mockReturnValue('invalid_session_token');

      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'session=invalid_session_token',
        },
      });

      const response = await POST(request);
      const body = await response.json();

      // Logout should still succeed
      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');
      // Session revoke should still be attempted with the actual token
      expect(sessionService.revokeSession).toHaveBeenCalledWith('invalid_session_token', 'logout');
      // Cookies should be cleared
      expect(appendClearCookies).toHaveBeenCalledTimes(1);
      expect(vi.mocked(appendClearCookies).mock.calls[0][0]).toBeInstanceOf(Headers);
    });

    it('handles session revocation failure gracefully', async () => {
      vi.mocked(sessionService.revokeSession).mockRejectedValueOnce(
        new Error('Database error')
      );

      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'session=ps_sess_mock_session_token',
        },
      });

      const response = await POST(request);
      const body = await response.json();

      // Logout should still succeed even if revocation fails
      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');
      // Cookies should still be cleared
      expect(appendClearCookies).toHaveBeenCalledTimes(1);
      expect(vi.mocked(appendClearCookies).mock.calls[0][0]).toBeInstanceOf(Headers);
    });

    it('does not log logout event when no user ID', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'session=ps_sess_mock_session_token',
        },
      });

      await POST(request);

      // Should not log when no user ID
      expect(logAuthEvent).not.toHaveBeenCalled();
      expect(trackAuthEvent).not.toHaveBeenCalled();
    });
  });

  describe('audit persistence failure logging', () => {
    const mockSecurityWarn = vi.mocked(loggers.security.warn);
    const mockLogLogout = vi.mocked(securityAudit.logLogout);
    const mockLogTokenRevoked = vi.mocked(securityAudit.logTokenRevoked);

    it('logs warning when logLogout rejects and still returns 200', async () => {
      mockLogLogout.mockRejectedValueOnce(new Error('Audit DB down'));

      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'session=ps_sess_mock_session_token',
        },
      });

      const response = await POST(request);
      await new Promise(process.nextTick);

      expect(response.status).toBe(200);
      expect(mockSecurityWarn).toHaveBeenCalledWith(
        '[Logout] audit logLogout failed',
        expect.objectContaining({ error: expect.any(String), userId: 'test-user-id' })
      );
    });

    it('logs warning when logTokenRevoked rejects and still returns 200', async () => {
      mockLogTokenRevoked.mockRejectedValueOnce(new Error('Write failed'));

      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'session=ps_sess_mock_session_token',
        },
      });

      const response = await POST(request);
      await new Promise(process.nextTick);

      expect(response.status).toBe(200);
      expect(mockSecurityWarn).toHaveBeenCalledWith(
        '[Logout] audit logTokenRevoked failed',
        expect.objectContaining({ error: expect.any(String), userId: 'test-user-id' })
      );
    });
  });
});
