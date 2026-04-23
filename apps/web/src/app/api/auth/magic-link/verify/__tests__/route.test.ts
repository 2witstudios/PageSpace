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
vi.mock('@pagespace/lib/auth', () => ({
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
  },
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,
}));

vi.mock('@pagespace/lib/auth/magic-link-service', () => ({
  verifyMagicLinkToken: vi.fn().mockResolvedValue({
    ok: true,
    data: { userId: 'test-user-id', isNewUser: false },
  }),
}));

vi.mock('@pagespace/lib/verification-utils', () => ({
  markEmailVerified: vi.fn().mockResolvedValue(undefined),
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
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
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

import { GET } from '../route';
import { sessionService } from '@pagespace/lib/auth';
import { verifyMagicLinkToken } from '@pagespace/lib/auth/magic-link-service';
import { markEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { loggers, auditRequest } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/monitoring/activity-tracker';
import { getClientIP } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

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
});
