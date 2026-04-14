/**
 * Contract tests for POST /api/auth/passkey/authenticate
 *
 * Tests the Request -> Response contract for verifying WebAuthn authentication.
 * Public endpoint (unauthenticated) - requires login CSRF token.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: init?.headers ?? new Headers({ 'Content-Type': 'application/json' }),
    }),
  },
}));

vi.mock('@pagespace/lib/auth', () => ({
  verifyAuthentication: vi.fn(),
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_session_token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'user-1',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }),
    revokeAllUserSessions: vi.fn().mockResolvedValue(0),
  },
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
  createExchangeCode: vi.fn().mockResolvedValue('mock-exchange-code'),
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,
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
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn(),
  resetDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: {
    PASSKEY_AUTH: { maxAttempts: 5, windowMs: 300000, progressiveDelay: true },
  },
}));

vi.mock('@/lib/auth', () => ({
  validateLoginCSRFToken: vi.fn(),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
  createDeviceToken: vi.fn().mockResolvedValue('ps_dev_mock_token'),
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
}));

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserById: vi.fn().mockResolvedValue({
      id: 'user-1',
      tokenVersion: 5,
    }),
  },
}));

import { POST } from '../route';
import {
  verifyAuthentication,
  sessionService,
  generateCSRFToken,
  createExchangeCode,
} from '@pagespace/lib/auth';
import { loggers, auditRequest } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { checkDistributedRateLimit, resetDistributedRateLimit } from '@pagespace/lib/security';
import { validateLoginCSRFToken, getClientIP, createDeviceToken } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';

const validPayload = {
  response: { id: 'cred-1', rawId: 'raw', type: 'public-key' },
  expectedChallenge: 'challenge-123',
  csrfToken: 'valid-csrf',
};

const createRequest = (body: Record<string, unknown> = validPayload) =>
  new Request('http://localhost/api/auth/passkey/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/auth/passkey/authenticate', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: true,
      attemptsRemaining: 4,
    });
    vi.mocked(validateLoginCSRFToken).mockReturnValue(true);
    vi.mocked(verifyAuthentication).mockResolvedValue({
      ok: true,
      // @ts-expect-error - partial mock data
      data: { userId: 'user-1' },
    });
  });

  describe('successful authentication', () => {
    it('returns 200 with success, userId, and redirectUrl', async () => {
      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.userId).toBe('user-1');
      expect(body.redirectUrl).toBe('/dashboard');
    });

    it('sets session cookie and CSRF cookie', async () => {
      const response = await POST(createRequest());

      expect(appendSessionCookie).toHaveBeenCalledTimes(1);
      expect(vi.mocked(appendSessionCookie).mock.calls[0][0]).toBeInstanceOf(Headers);
      expect(vi.mocked(appendSessionCookie).mock.calls[0][1]).toBe('ps_sess_mock_session_token');
      expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');

      // Check Set-Cookie contains CSRF token
      const cookies = response.headers.getSetCookie();
      const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
      expect(csrfCookie).toContain('mock-csrf-token');
    });

    it('revokes existing sessions before creating new one', async () => {
      await POST(createRequest());

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith('user-1', 'passkey_login');
      expect(sessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-1',
        type: 'user',
        scopes: ['*'],
      }));
    });

    it('logs when existing sessions are revoked', async () => {
      vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(3);

      await POST(createRequest());

      expect(loggers.auth.info).toHaveBeenCalledWith('Revoked all sessions on passkey login', expect.objectContaining({
        userId: 'user-1',
        count: 3,
      }));
    });

    it('does not log when no sessions are revoked', async () => {
      vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(0);

      await POST(createRequest());

      expect(loggers.auth.info).not.toHaveBeenCalledWith(
        'Revoked all sessions on passkey login',
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('passes clientIP as createdByIp when not unknown', async () => {
      vi.mocked(getClientIP).mockReturnValue('192.168.1.1');

      await POST(createRequest());

      expect(sessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({
        createdByIp: '192.168.1.1',
      }));
    });

    it('passes undefined createdByIp when IP is unknown', async () => {
      vi.mocked(getClientIP).mockReturnValue('unknown');

      await POST(createRequest());

      expect(sessionService.createSession).toHaveBeenCalledWith(expect.objectContaining({
        createdByIp: undefined,
      }));
    });

    it('generates CSRF token bound to session ID', async () => {
      await POST(createRequest());

      expect(sessionService.validateSession).toHaveBeenCalledWith('ps_sess_mock_session_token');
      expect(generateCSRFToken).toHaveBeenCalledWith('mock-session-id');
    });

    it('resets rate limit on successful login', async () => {
      await POST(createRequest());

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('passkey_auth:127.0.0.1');
    });

    it('tracks successful passkey login event', async () => {
      await POST(createRequest());

      expect(trackAuthEvent).toHaveBeenCalledWith('user-1', 'passkey_login', expect.objectContaining({
        ip: '127.0.0.1',
      }));
    });

    it('audits successful passkey login', async () => {
      await POST(createRequest());

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'auth.login.success',
          userId: 'user-1',
          sessionId: 'mock-session-id',
        })
      );
    });

    it('does not include Secure flag in non-production', async () => {
      vi.stubEnv('NODE_ENV', 'test');

      const response = await POST(createRequest());
      const cookies = response.headers.getSetCookie();
      const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
      expect(csrfCookie).not.toContain('; Secure');

      vi.unstubAllEnvs();
    });

    it('includes Secure flag in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      const response = await POST(createRequest());
      const cookies = response.headers.getSetCookie();
      const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
      expect(csrfCookie).toContain('; Secure');

      vi.unstubAllEnvs();
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when rate limited', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 300,
      });

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toBe('Too many requests');
      expect(body.retryAfter).toBe(300);
      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'security.rate.limited',
          details: expect.objectContaining({ reason: 'passkey_rate_limit_auth' }),
          riskScore: 0.5,
        })
      );
    });
  });

  describe('input validation', () => {
    it('returns 400 for missing expectedChallenge', async () => {
      const response = await POST(createRequest({ response: {}, csrfToken: 'csrf' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 for missing csrfToken', async () => {
      const response = await POST(createRequest({ response: {}, expectedChallenge: 'ch' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 for empty expectedChallenge', async () => {
      const response = await POST(createRequest({ response: {}, expectedChallenge: '', csrfToken: 'valid' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 for empty csrfToken', async () => {
      const response = await POST(createRequest({ response: {}, expectedChallenge: 'ch', csrfToken: '' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });
  });

  describe('CSRF validation', () => {
    it('returns 403 when CSRF token is invalid', async () => {
      vi.mocked(validateLoginCSRFToken).mockReturnValue(false);

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Invalid CSRF token');
      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'security.suspicious.activity',
          details: expect.objectContaining({ reason: 'passkey_csrf_invalid', flow: 'authenticate' }),
          riskScore: 0.6,
        })
      );
    });
  });

  describe('verification errors', () => {
    const errorCases = [
      { code: 'CREDENTIAL_NOT_FOUND', status: 400, message: 'Passkey not found' },
      { code: 'CHALLENGE_NOT_FOUND', status: 400, message: 'Challenge not found or invalid' },
      { code: 'CHALLENGE_EXPIRED', status: 400, message: 'Challenge expired, please try again' },
      { code: 'CHALLENGE_ALREADY_USED', status: 400, message: 'Challenge already used' },
      { code: 'VERIFICATION_FAILED', status: 400, message: 'Verification failed' },
      { code: 'USER_SUSPENDED', status: 403, message: 'Account suspended' },
      { code: 'COUNTER_REPLAY_DETECTED', status: 400, message: 'Security error: credential replay detected' },
    ];

    errorCases.forEach(({ code, status, message }) => {
      it(`returns ${status} for ${code}`, async () => {
        vi.mocked(verifyAuthentication).mockResolvedValue({
          ok: false,
          // @ts-expect-error - partial mock data
          error: { code, message: 'Error' },
        });

        const response = await POST(createRequest());
        const body = await response.json();

        expect(response.status).toBe(status);
        expect(body.error).toBe(message);
        expect(body.code).toBe(code);
      });
    });

    it('returns 500 for unknown error code', async () => {
      vi.mocked(verifyAuthentication).mockResolvedValue({
        ok: false,
        // @ts-expect-error - partial mock data
        error: { code: 'UNKNOWN_ERROR', message: 'Something' },
      });

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
      expect(body.code).toBe('UNKNOWN_ERROR');
    });

    it('logs verification failure', async () => {
      vi.mocked(verifyAuthentication).mockResolvedValue({
        ok: false,
        error: { code: 'VERIFICATION_FAILED', message: 'Error' },
      });

      await POST(createRequest());

      expect(loggers.auth.warn).toHaveBeenCalledWith('Passkey authentication failed', expect.objectContaining({
        error: 'VERIFICATION_FAILED',
      }));
    });

    it('audits auth failure on verification error', async () => {
      vi.mocked(verifyAuthentication).mockResolvedValue({
        ok: false,
        error: { code: 'VERIFICATION_FAILED', message: 'Error' },
      });

      await POST(createRequest());

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'auth.login.failure',
          details: expect.objectContaining({ reason: 'passkey_auth_verification_failed' }),
          riskScore: 0.3,
        })
      );
    });
  });

  describe('session creation errors', () => {
    it('returns 500 when session validation fails after creation', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValueOnce(null);

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Session creation failed');
      expect(loggers.auth.error).toHaveBeenCalledWith('Failed to validate newly created session', expect.objectContaining({
        userId: 'user-1',
      }));
    });
  });

  describe('unexpected errors', () => {
    it('returns 500 on unexpected throw', async () => {
      vi.mocked(checkDistributedRateLimit).mockRejectedValueOnce(new Error('Unexpected'));

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
      expect(loggers.auth.error).toHaveBeenCalledWith('Passkey auth verification error', new Error('Unexpected'));
    });
  });

  describe('device token creation', () => {
    it('does not create device token without deviceId', async () => {
      await POST(createRequest());

      expect(createDeviceToken).not.toHaveBeenCalled();
    });
  });

  describe('desktop external-browser handoff (desktopExchange flag)', () => {
    const desktopExchangePayload = {
      ...validPayload,
      platform: 'desktop' as const,
      deviceId: 'device-xyz',
      deviceName: 'Jono Mac',
      desktopExchange: true,
    };

    const createExchangeRequest = () =>
      new Request('http://localhost/api/auth/passkey/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(desktopExchangePayload),
      });

    it('mints an exchange code with the created session, csrf and device tokens', async () => {
      await POST(createExchangeRequest());

      expect(createExchangeCode).toHaveBeenCalledWith(expect.objectContaining({
        sessionToken: 'ps_sess_mock_session_token',
        csrfToken: 'mock-csrf-token',
        deviceToken: 'ps_dev_mock_token',
        provider: 'passkey',
        userId: 'user-1',
      }));
    });

    it('returns desktopExchangeCode at the top of the response body', async () => {
      const response = await POST(createExchangeRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.desktopExchangeCode).toBe('mock-exchange-code');
    });

    it('does not return raw session tokens when desktopExchange is set', async () => {
      const response = await POST(createExchangeRequest());
      const body = await response.json();

      expect(body.sessionToken).toBeUndefined();
      expect(body.csrfToken).toBeUndefined();
      expect(body.deviceToken).toBeUndefined();
    });

    it('does not set a session cookie on the response when using exchange handoff', async () => {
      await POST(createExchangeRequest());

      expect(appendSessionCookie).not.toHaveBeenCalled();
    });

    it('still creates a session and device token (exchange is just the delivery mechanism)', async () => {
      await POST(createExchangeRequest());

      expect(sessionService.createSession).toHaveBeenCalled();
      expect(createDeviceToken).toHaveBeenCalledWith(expect.objectContaining({
        platform: 'desktop',
        deviceId: 'device-xyz',
      }));
    });

    it('returns 400 if desktopExchange is set with platform=web (inconsistent request)', async () => {
      const response = await POST(
        new Request('http://localhost/api/auth/passkey/authenticate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...validPayload,
            platform: 'web',
            deviceId: 'device-xyz',
            desktopExchange: true,
          }),
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/platform/i);
      expect(createExchangeCode).not.toHaveBeenCalled();
    });

    it('logs an auth.info entry on successful exchange mint', async () => {
      await POST(createExchangeRequest());

      expect(loggers.auth.info).toHaveBeenCalledWith(
        'Desktop passkey exchange mint',
        expect.objectContaining({ userId: 'user-1', provider: 'passkey' }),
      );
    });

    it('returns 400 if desktopExchange is set without deviceId (device token required)', async () => {
      const response = await POST(
        new Request('http://localhost/api/auth/passkey/authenticate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...validPayload,
            platform: 'desktop',
            desktopExchange: true,
          }),
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/device/i);
      expect(createExchangeCode).not.toHaveBeenCalled();
    });
  });

  describe('platform=desktop requires desktopExchange (legacy raw-token path removed)', () => {
    it('returns 400 when platform=desktop is sent without desktopExchange=true', async () => {
      const response = await POST(
        new Request('http://localhost/api/auth/passkey/authenticate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...validPayload,
            platform: 'desktop',
            deviceId: 'device-xyz',
            deviceName: 'My Mac',
          }),
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/desktopExchange/i);
      expect(sessionService.createSession).not.toHaveBeenCalled();
      expect(appendSessionCookie).not.toHaveBeenCalled();
      expect(createExchangeCode).not.toHaveBeenCalled();
    });

    it('never returns a raw sessionToken in the response body for any desktop request', async () => {
      const response = await POST(
        new Request('http://localhost/api/auth/passkey/authenticate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...validPayload,
            platform: 'desktop',
            deviceId: 'device-xyz',
            deviceName: 'My Mac',
            desktopExchange: true,
          }),
        }),
      );
      const body = await response.json();

      expect(body.sessionToken).toBeUndefined();
      expect(body.deviceToken).toBeUndefined();
    });
  });

  describe('deviceName input bounds', () => {
    it('returns 400 when deviceName exceeds 256 characters', async () => {
      const response = await POST(
        new Request('http://localhost/api/auth/passkey/authenticate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...validPayload,
            platform: 'desktop',
            deviceId: 'device-xyz',
            deviceName: 'x'.repeat(257),
            desktopExchange: true,
          }),
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
    });
  });
});
