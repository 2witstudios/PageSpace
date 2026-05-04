/**
 * Contract tests for GET /api/auth/magic-link/verify
 *
 * Coverage:
 * - Token format validation (missing/empty token)
 * - Token verification (expired, already used, not found, suspended, validation failed, unknown)
 * - Session fixation prevention (revoke existing sessions)
 * - Email verification marking (success and failure)
 * - Session creation and CSRF token generation
 * - Session validation failure
 * - Auth event logging
 * - New user drive provisioning
 * - Redirect URL construction
 * - CSRF cookie setting
 * - Production secure flag
 * - Error handling
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock dependencies BEFORE imports
vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'test-user-id',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }),
    revokeAllUserSessions: vi.fn().mockResolvedValue(0),
    revokeSession: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@pagespace/lib/auth/csrf-utils', () => ({
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
}));
vi.mock('@pagespace/lib/auth/constants', () => ({
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,
}));

vi.mock('@pagespace/lib/auth/magic-link-service', () => ({
  verifyMagicLinkToken: vi.fn().mockResolvedValue({
    ok: true,
    data: { userId: 'test-user-id', isNewUser: false },
  }),
}));

vi.mock('@pagespace/lib/auth/verification-utils', () => ({
  markEmailVerified: vi.fn().mockResolvedValue(undefined),
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

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue({ driveId: 'new-drive-id', created: true }),
}));

vi.mock('@/lib/auth/post-login-pending-acceptance', () => ({
  acceptUserPendingInvitations: vi.fn().mockResolvedValue([]),
}));

import { GET } from '../route';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { verifyMagicLinkToken } from '@pagespace/lib/auth/magic-link-service';
import { markEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { trackAuthEvent } from '@pagespace/lib/monitoring/activity-tracker';
import { getClientIP } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { acceptUserPendingInvitations } from '@/lib/auth/post-login-pending-acceptance';

const createVerifyRequest = (token?: string) => {
  const url = token
    ? `http://localhost/api/auth/magic-link/verify?token=${token}`
    : 'http://localhost/api/auth/magic-link/verify';

  return new Request(url, {
    method: 'GET',
    headers: { 'User-Agent': 'TestBrowser/1.0' },
  });
};

describe('GET /api/auth/magic-link/verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('WEB_APP_URL', 'https://example.com');
    vi.stubEnv('NODE_ENV', 'test');
    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(verifyMagicLinkToken).mockResolvedValue({
      ok: true,
      data: { userId: 'test-user-id', isNewUser: false },
    });
    vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(0);
    // @ts-expect-error - partial mock data
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'test-user-id',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('token validation', () => {
    it('redirects with invalid_token when token is missing', async () => {
      const request = createVerifyRequest();
      const response = await GET(request);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=invalid_token');
    });

    it('redirects with invalid_token when token is empty', async () => {
      const request = createVerifyRequest('');
      const response = await GET(request);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=invalid_token');
    });
  });

  describe('token verification errors', () => {
    it('redirects with magic_link_expired for TOKEN_EXPIRED', async () => {
      vi.mocked(verifyMagicLinkToken).mockResolvedValue({
        ok: false,
        // @ts-expect-error - test mock with extra properties
        error: { code: 'TOKEN_EXPIRED', message: 'Token expired' },
      });

      const response = await GET(createVerifyRequest('expired-token'));

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=magic_link_expired');
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Magic link verification failed',
        expect.objectContaining({ error: 'TOKEN_EXPIRED' })
      );
    });

    it('redirects with magic_link_used for TOKEN_ALREADY_USED', async () => {
      vi.mocked(verifyMagicLinkToken).mockResolvedValue({
        ok: false,
        // @ts-expect-error - test mock with extra properties
        error: { code: 'TOKEN_ALREADY_USED', message: 'Already used' },
      });

      const response = await GET(createVerifyRequest('used-token'));
      const location = response.headers.get('Location')!;

      expect(location).toContain('error=magic_link_used');
    });

    it('redirects with invalid_token for TOKEN_NOT_FOUND', async () => {
      vi.mocked(verifyMagicLinkToken).mockResolvedValue({
        ok: false,
        // @ts-expect-error - test mock with extra properties
        error: { code: 'TOKEN_NOT_FOUND', message: 'Not found' },
      });

      const response = await GET(createVerifyRequest('unknown-token'));
      const location = response.headers.get('Location')!;

      expect(location).toContain('error=invalid_token');
    });

    it('redirects with account_suspended for USER_SUSPENDED', async () => {
      vi.mocked(verifyMagicLinkToken).mockResolvedValue({
        ok: false,
        // @ts-expect-error - test mock with extra properties
        error: { code: 'USER_SUSPENDED', message: 'Suspended' },
      });

      const response = await GET(createVerifyRequest('suspended-token'));
      const location = response.headers.get('Location')!;

      expect(location).toContain('error=account_suspended');
    });

    it('redirects with invalid_token for VALIDATION_FAILED', async () => {
      vi.mocked(verifyMagicLinkToken).mockResolvedValue({
        ok: false,
        error: { code: 'VALIDATION_FAILED', message: 'Invalid' },
      });

      const response = await GET(createVerifyRequest('bad-token'));
      const location = response.headers.get('Location')!;

      expect(location).toContain('error=invalid_token');
    });

    it('redirects with invalid_token for unknown error codes', async () => {
      vi.mocked(verifyMagicLinkToken).mockResolvedValue({
        ok: false,
        // @ts-expect-error - partial mock data
        error: { code: 'UNKNOWN_ERROR', message: 'Unknown' },
      });

      const response = await GET(createVerifyRequest('bad-token'));
      const location = response.headers.get('Location')!;

      expect(location).toContain('error=invalid_token');
    });
  });

  describe('session management', () => {
    it('revokes existing sessions before creating new one', async () => {
      vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(2);

      await GET(createVerifyRequest('valid-token'));

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
        'test-user-id',
        'magic_link_login'
      );
      expect(loggers.auth.info).toHaveBeenCalledWith(
        'Revoked existing sessions on magic link login',
        expect.objectContaining({ count: 2 })
      );
    });

    it('does not log when no sessions were revoked', async () => {
      vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(0);

      await GET(createVerifyRequest('valid-token'));

      const logCalls = vi.mocked(loggers.auth.info).mock.calls;
      const revokedLogCall = logCalls.find(
        (call) => call[0] === 'Revoked existing sessions on magic link login'
      );
      expect(revokedLogCall).toBeUndefined();
    });

    it('creates session with correct params', async () => {
      vi.mocked(getClientIP).mockReturnValue('192.168.1.1');

      await GET(createVerifyRequest('valid-token'));

      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'test-user-id',
          type: 'user',
          scopes: ['*'],
          createdByIp: '192.168.1.1',
        })
      );
    });

    it('omits createdByIp when client IP is unknown', async () => {
      vi.mocked(getClientIP).mockReturnValue('unknown');

      await GET(createVerifyRequest('valid-token'));

      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          createdByIp: undefined,
        })
      );
    });

    it('redirects with session_error when session validation fails', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(null as never);

      const response = await GET(createVerifyRequest('valid-token'));

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=session_error');
    });
  });

  describe('email verification', () => {
    it('marks email as verified', async () => {
      await GET(createVerifyRequest('valid-token'));

      expect(markEmailVerified).toHaveBeenCalledWith('test-user-id');
    });

    it('continues login even if email verification fails', async () => {
      vi.mocked(markEmailVerified).mockRejectedValueOnce(new Error('DB error'));

      const response = await GET(createVerifyRequest('valid-token'));

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/dashboard');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Failed to mark email as verified',
        new Error('DB error'),
        { userId: 'test-user-id' }
      );
    });
  });

  describe('auth event logging', () => {
    it('logs magic link login event', async () => {
      await GET(createVerifyRequest('valid-token'));

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'auth.login.success',
          userId: 'test-user-id',
          sessionId: 'mock-session-id',
          details: expect.objectContaining({ method: 'magic_link' }),
        })
      );
      expect(trackAuthEvent).toHaveBeenCalledWith(
        'test-user-id',
        'magic_link_login',
        expect.objectContaining({
          ip: '127.0.0.1',
          isNewUser: false,
        })
      );
    });
  });

  describe('new user drive provisioning', () => {
    it('provisions drive for new users and redirects to it', async () => {
      vi.mocked(verifyMagicLinkToken).mockResolvedValue({
        ok: true,
        data: { userId: 'test-user-id', isNewUser: true },
      });
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({
        driveId: 'provisioned-drive-id',
        created: true,
      });

      const response = await GET(createVerifyRequest('valid-token'));
      const location = response.headers.get('Location')!;

      expect(location).toContain('/dashboard/provisioned-drive-id');
      expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith('test-user-id');
    });

    it('uses default dashboard path when drive provisioning returns null', async () => {
      vi.mocked(verifyMagicLinkToken).mockResolvedValue({
        ok: true,
        data: { userId: 'test-user-id', isNewUser: true },
      });
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue(null as never);

      const response = await GET(createVerifyRequest('valid-token'));
      const location = response.headers.get('Location')!;

      expect(location).toContain('/dashboard');
    });

    it('continues with default dashboard when drive provisioning fails', async () => {
      vi.mocked(verifyMagicLinkToken).mockResolvedValue({
        ok: true,
        data: { userId: 'test-user-id', isNewUser: true },
      });
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockRejectedValueOnce(new Error('DB error'));

      const response = await GET(createVerifyRequest('valid-token'));
      const location = response.headers.get('Location')!;

      expect(location).toContain('/dashboard');
      expect(location).not.toContain('provisioned');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Failed to provision Getting Started drive',
        new Error('DB error'),
        { userId: 'test-user-id' }
      );
    });

    it('does not provision drive for existing users', async () => {
      vi.mocked(verifyMagicLinkToken).mockResolvedValue({
        ok: true,
        data: { userId: 'test-user-id', isNewUser: false },
      });

      await GET(createVerifyRequest('valid-token'));

      expect(provisionGettingStartedDriveIfNeeded).not.toHaveBeenCalled();
    });
  });

  describe('redirect and cookies', () => {
    it('redirects to dashboard with auth=success', async () => {
      const response = await GET(createVerifyRequest('valid-token'));

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/dashboard');
      expect(location).toContain('auth=success');
    });

    it('sets session cookie', async () => {
      await GET(createVerifyRequest('valid-token'));

      expect(appendSessionCookie).toHaveBeenCalledTimes(1);
      const [verifyHeaders, verifyToken] = vi.mocked(appendSessionCookie).mock.calls[0];
      expect(verifyHeaders).toBeInstanceOf(Headers);
      expect(verifyToken).toBe('ps_sess_mock_token');
    });

    it('sets CSRF token cookie without Secure flag in non-production', async () => {
      vi.stubEnv('NODE_ENV', 'test');

      const response = await GET(createVerifyRequest('valid-token'));

      const setCookies = response.headers.getSetCookie?.() ||
        [response.headers.get('Set-Cookie')].filter(Boolean);
      const csrfCookie = setCookies.find((c: string) => c?.includes('csrf_token='));

      expect(csrfCookie).toBe(
        'csrf_token=mock-csrf-token; Path=/; HttpOnly=false; SameSite=Lax; Max-Age=60'
      );
      expect(csrfCookie).not.toContain('Secure');
    });

    it('sets CSRF token cookie with Secure flag in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      const response = await GET(createVerifyRequest('valid-token'));

      const setCookies = response.headers.getSetCookie?.() ||
        [response.headers.get('Set-Cookie')].filter(Boolean);
      const csrfCookie = setCookies.find((c: string) => c?.includes('csrf_token='));

      expect(csrfCookie).toBe(
        'csrf_token=mock-csrf-token; Path=/; HttpOnly=false; SameSite=Lax; Max-Age=60; Secure'
      );
      expect(csrfCookie).toContain('; Secure');
    });

    it('uses NEXT_PUBLIC_APP_URL as fallback', async () => {
      delete process.env.WEB_APP_URL;
      process.env.NEXT_PUBLIC_APP_URL = 'https://public.example.com';

      const response = await GET(createVerifyRequest('valid-token'));
      const location = response.headers.get('Location')!;

      expect(location).toContain('https://public.example.com');
    });

    it('uses localhost as final fallback', async () => {
      delete process.env.WEB_APP_URL;
      delete process.env.NEXT_PUBLIC_APP_URL;

      const response = await GET(createVerifyRequest('valid-token'));
      const location = response.headers.get('Location')!;

      expect(location).toContain('http://localhost:3000');
    });

    it('logs successful magic link login', async () => {
      await GET(createVerifyRequest('valid-token'));

      expect(loggers.auth.info).toHaveBeenCalledWith(
        'Magic link login successful',
        expect.objectContaining({
          userId: 'test-user-id',
          isNewUser: false,
        })
      );
    });
  });

  describe('error handling', () => {
    it('redirects with server_error on unexpected exception', async () => {
      vi.mocked(verifyMagicLinkToken).mockRejectedValueOnce(new Error('Unexpected'));

      const response = await GET(createVerifyRequest('valid-token'));

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=server_error');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Magic link verify error',
        new Error('Unexpected')
      );
    });
  });

  describe('post-login pending invite acceptance', () => {
    const createVerifyRequestWithInvite = (token: string, inviteDriveId?: string) => {
      const params = new URLSearchParams({ token });
      if (inviteDriveId) params.set('inviteDriveId', inviteDriveId);
      return new Request(`http://localhost/api/auth/magic-link/verify?${params.toString()}`, {
        method: 'GET',
        headers: { 'User-Agent': 'TestBrowser/1.0' },
      });
    };

    it('given a successful verify, calls acceptUserPendingInvitations after createSession with the resolved userId', async () => {
      await GET(createVerifyRequest('valid-token'));

      expect(acceptUserPendingInvitations).toHaveBeenCalledWith('test-user-id');
      const acceptOrder = vi.mocked(acceptUserPendingInvitations).mock.invocationCallOrder[0];
      const sessionOrder = vi.mocked(sessionService.createSession).mock.invocationCallOrder[0];
      expect(acceptOrder).toBeGreaterThan(sessionOrder);
    });

    it('given inviteDriveId AND a matching pending row, redirects to /dashboard/<driveId> after accepting', async () => {
      vi.mocked(acceptUserPendingInvitations).mockResolvedValueOnce([
        { driveId: 'drive_invited', driveName: 'Invited', role: 'MEMBER' },
      ]);

      const response = await GET(createVerifyRequestWithInvite('valid-token', 'drive_invited'));
      const location = response.headers.get('Location')!;

      expect(response.status).toBe(302);
      expect(location).toContain('/dashboard/drive_invited');
    });

    it('given no inviteDriveId but other pending rows exist, all are still accepted and the default redirect is used', async () => {
      vi.mocked(acceptUserPendingInvitations).mockResolvedValueOnce([
        { driveId: 'drive_other', driveName: 'Other', role: 'MEMBER' },
      ]);

      const response = await GET(createVerifyRequest('valid-token'));
      const location = response.headers.get('Location')!;

      expect(acceptUserPendingInvitations).toHaveBeenCalledWith('test-user-id');
      expect(location).toContain('/dashboard');
      expect(location).not.toContain('/dashboard/drive_other');
    });

    it('given inviteDriveId with no matching pending row, falls through to the default redirect (no error)', async () => {
      vi.mocked(acceptUserPendingInvitations).mockResolvedValueOnce([
        { driveId: 'drive_other', driveName: 'Other', role: 'MEMBER' },
      ]);

      const response = await GET(createVerifyRequestWithInvite('valid-token', 'drive_unknown'));
      const location = response.headers.get('Location')!;

      expect(response.status).toBe(302);
      expect(location).toContain('/dashboard');
      expect(location).not.toContain('/dashboard/drive_unknown');
      expect(location).not.toContain('error=');
    });

    it('given acceptUserPendingInvitations throws (genuine DB failure), revokes the just-created session and redirects to signin?error=server_error', async () => {
      vi.mocked(acceptUserPendingInvitations).mockRejectedValueOnce(new Error('db down'));

      const response = await GET(createVerifyRequest('valid-token'));
      const location = response.headers.get('Location')!;

      expect(response.status).toBe(302);
      expect(location).toContain('/auth/signin?error=server_error');
      expect(sessionService.revokeSession).toHaveBeenCalledWith(
        'ps_sess_mock_token',
        'pending_invite_acceptance_failed'
      );
      expect(sessionService.revokeAllUserSessions).not.toHaveBeenCalledWith(
        expect.anything(),
        'pending_invite_acceptance_failed'
      );
    });

    it('given a desktop magic-link flow, runs the pending acceptance hook before redirect', async () => {
      vi.mocked(verifyMagicLinkToken).mockResolvedValueOnce({
        ok: true,
        data: {
          userId: 'test-user-id',
          isNewUser: false,
          metadata: JSON.stringify({ platform: 'desktop', deviceId: 'dev-1' }),
        },
      });

      // Make the desktop branch fall through to the web redirect (authRepository
      // findUserById returns null), but acceptance should still have run.
      await GET(createVerifyRequest('valid-token'));

      expect(acceptUserPendingInvitations).toHaveBeenCalledWith('test-user-id');
    });
  });
});
