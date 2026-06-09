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
vi.mock('@pagespace/lib/auth/session-service', () => ({
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
}));
vi.mock('@pagespace/lib/auth/csrf-utils', () => ({
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
}));

// Device-token revocation seam (M9)
vi.mock('@pagespace/lib/auth/device-auth-utils', () => ({
  revokeDeviceTokenByValue: vi.fn().mockResolvedValue(true),
  revokeDeviceTokensByDevice: vi.fn().mockResolvedValue(1),
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
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

import { sessionService } from '@pagespace/lib/auth/session-service';
import {
  revokeDeviceTokenByValue,
  revokeDeviceTokensByDevice,
} from '@pagespace/lib/auth/device-auth-utils';
import { getSessionFromCookies, appendClearCookies } from '@/lib/auth/cookie-config';
import { getClientIP } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { trackAuthEvent } from '@pagespace/lib/monitoring/activity-tracker';

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

    it('logs logout event via auditRequest', async () => {
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

      expect(auditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'auth.logout',
          userId: 'test-user-id',
          sessionId: 'test-session-id',
        })
      );
      expect(auditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'auth.token.revoked',
          userId: 'test-user-id',
          details: { tokenType: 'session', reason: 'user_logout' },
        })
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
      expect(auditRequest).not.toHaveBeenCalled();
      expect(trackAuthEvent).not.toHaveBeenCalled();
    });
  });

  describe('device token revocation on logout (M9)', () => {
    it('revokes the device token by value when the client sends one', async () => {
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceToken: 'ps_dev_caller_token' }),
      });

      await POST(request);

      expect(revokeDeviceTokenByValue).toHaveBeenCalledWith('ps_dev_caller_token', 'logout');
      expect(revokeDeviceTokensByDevice).not.toHaveBeenCalled();
    });

    it('revokes by userId + deviceId + platform when no token value is sent (desktop logout)', async () => {
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'device-abc', platform: 'desktop' }),
      });

      await POST(request);

      expect(revokeDeviceTokensByDevice).toHaveBeenCalledWith(
        'test-user-id',
        'device-abc',
        'desktop',
        'logout'
      );
      expect(revokeDeviceTokenByValue).not.toHaveBeenCalled();
    });

    it('emits a device token.revoked audit event when a device token is revoked', async () => {
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'device-abc', platform: 'desktop' }),
      });

      await POST(request);

      expect(auditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'auth.token.revoked',
          userId: 'test-user-id',
          details: { tokenType: 'device', reason: 'user_logout' },
        })
      );
    });

    it('does not revoke any device token for a plain web logout (no device context)', async () => {
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      await POST(request);

      expect(revokeDeviceTokenByValue).not.toHaveBeenCalled();
      expect(revokeDeviceTokensByDevice).not.toHaveBeenCalled();
    });

    it('still logs out successfully (200) if device token revocation throws', async () => {
      vi.mocked(revokeDeviceTokenByValue).mockRejectedValueOnce(new Error('db down'));

      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceToken: 'ps_dev_caller_token' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');
      expect(appendClearCookies).toHaveBeenCalledTimes(1);
    });

    it('does not attempt device revocation when there is no valid session/user', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // deviceId+platform present but no token value → would be by-device,
        // which requires a userId we don't have.
        body: JSON.stringify({ deviceId: 'device-abc', platform: 'desktop' }),
      });

      await POST(request);

      expect(revokeDeviceTokensByDevice).not.toHaveBeenCalled();
    });
  });

  describe('audit event types', () => {
    it('emits both auth.logout and auth.token.revoked events', async () => {
      const request = new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'session=ps_sess_mock_session_token',
        },
      });

      await POST(request);

      const calls = vi.mocked(auditRequest).mock.calls;
      const eventTypes = calls.map(([, event]) => event.eventType);
      expect(eventTypes).toContain('auth.logout');
      expect(eventTypes).toContain('auth.token.revoked');
    });
  });
});
