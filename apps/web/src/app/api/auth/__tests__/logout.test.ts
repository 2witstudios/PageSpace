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

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
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
  },
  logAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

import { sessionService } from '@pagespace/lib/auth';
import { getSessionFromCookies, appendClearCookies } from '@/lib/auth/cookie-config';
import { getClientIP } from '@/lib/auth';
import { logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

describe('/api/auth/logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: valid session
    (getSessionFromCookies as unknown as Mock).mockReturnValue('ps_sess_mock_session_token');
    (sessionService.validateSession as unknown as Mock).mockResolvedValue({
      sessionId: 'test-session-id',
      userId: 'test-user-id',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
    });
    (getClientIP as Mock).mockReturnValue('unknown');
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

      expect(appendClearCookies).toHaveBeenCalled();
    });

    it('logs logout event', async () => {
      (getClientIP as Mock).mockReturnValue('192.168.1.1');

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
        expect.objectContaining({
          ip: '192.168.1.1',
        })
      );
    });
  });

  describe('edge cases', () => {
    it('handles missing session cookie gracefully', async () => {
      (getSessionFromCookies as unknown as Mock).mockReturnValue(null);

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
      expect(appendClearCookies).toHaveBeenCalled();
    });

    it('handles invalid session gracefully', async () => {
      (sessionService.validateSession as unknown as Mock).mockResolvedValue(null);

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
      // Session revoke should still be attempted
      expect(sessionService.revokeSession).toHaveBeenCalled();
      // Cookies should be cleared
      expect(appendClearCookies).toHaveBeenCalled();
    });

    it('handles session revocation failure gracefully', async () => {
      (sessionService.revokeSession as unknown as Mock).mockRejectedValue(
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
      expect(appendClearCookies).toHaveBeenCalled();
    });

    it('does not log logout event when no user ID', async () => {
      (sessionService.validateSession as unknown as Mock).mockResolvedValue(null);

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
});
