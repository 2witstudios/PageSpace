/**
 * Contract tests for POST /api/auth/signup-passkey
 *
 * Tests the Request -> Response contract for passkey-based signup.
 * Public endpoint (unauthenticated) - requires login CSRF token.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('@/lib/repositories/oauth-repository', () => ({
  oauthRepository: {
    createDefaultAiSettings: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@pagespace/lib/auth', () => ({
  verifySignupRegistration: vi.fn(),
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_session_token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'new-user-1',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }),
  },
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
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
    security: {
      warn: vi.fn(),
    },
  },
  auditRequest: vi.fn(),
  maskEmail: (email: string) => {
    const [local, domain] = email.split('@');
    if (!local || !domain) return '***@***';
    return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
  },
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn(),
  resetDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: {
    SIGNUP: { maxAttempts: 3, windowMs: 3600000, progressiveDelay: false },
  },
}));

vi.mock('@/lib/auth', () => ({
  validateLoginCSRFToken: vi.fn(),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue({ driveId: 'drive-1', created: true }),
}));

import { POST } from '../route';
import { oauthRepository } from '@/lib/repositories/oauth-repository';
import {
  verifySignupRegistration,
  sessionService,
  generateCSRFToken,
} from '@pagespace/lib/auth';
import { loggers, auditRequest } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { checkDistributedRateLimit, resetDistributedRateLimit } from '@pagespace/lib/security';
import { validateLoginCSRFToken, getClientIP } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

const validPayload = {
  email: 'user@example.com',
  name: 'Test User',
  response: { id: 'cred-1', rawId: 'raw', type: 'public-key' },
  expectedChallenge: 'challenge-123',
  csrfToken: 'valid-csrf',
  acceptedTos: true,
  passkeyName: 'My Device',
};

const createRequest = (body: Record<string, unknown> = validPayload) =>
  new Request('http://localhost/api/auth/signup-passkey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/auth/signup-passkey', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: true,
      attemptsRemaining: 2,
    });
    vi.mocked(validateLoginCSRFToken).mockReturnValue(true);
    vi.mocked(verifySignupRegistration).mockResolvedValue({
      ok: true,
      data: { userId: 'new-user-1', passkeyId: 'pk-1' },
    });
  });

  describe('successful signup', () => {
    it('returns 200 with success, userId, and redirectUrl', async () => {
      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.userId).toBe('new-user-1');
      expect(body.redirectUrl).toBe('/dashboard/drive-1?welcome=true');
    });

    it('sets session cookie and CSRF cookie', async () => {
      const response = await POST(createRequest());

      expect(appendSessionCookie).toHaveBeenCalledTimes(1);
      const [sessionHeaders, sessionToken] = vi.mocked(appendSessionCookie).mock.calls[0];
      expect(sessionHeaders).toBeInstanceOf(Headers);
      expect(sessionToken).toBe('ps_sess_mock_session_token');
      expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');

      const cookies = response.headers.getSetCookie();
      const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
      expect(csrfCookie).toContain('mock-csrf-token');
    });

    it('normalizes email to lowercase', async () => {
      await POST(createRequest({ ...validPayload, email: 'USER@EXAMPLE.COM' }));

      expect(verifySignupRegistration).toHaveBeenCalledWith(expect.objectContaining({
        email: 'user@example.com',
      }));
    });

    it('calls verifySignupRegistration with correct params', async () => {
      await POST(createRequest());

      expect(verifySignupRegistration).toHaveBeenCalledWith({
        email: 'user@example.com',
        name: 'Test User',
        response: validPayload.response,
        expectedChallenge: 'challenge-123',
        passkeyName: 'My Device',
        acceptedTos: true,
      });
    });

    it('provisions getting started drive', async () => {
      await POST(createRequest());

      expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith('new-user-1');
    });

    it('creates default AI settings for new user', async () => {
      await POST(createRequest());

      expect(oauthRepository.createDefaultAiSettings).toHaveBeenCalledWith('new-user-1');
    });

    it('logs auth events', async () => {
      await POST(createRequest());

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'auth.login.success',
          userId: 'new-user-1',
          details: expect.objectContaining({ signup: true, method: 'passkey' }),
        })
      );
    });

    it('resets rate limits on successful signup', async () => {
      await POST(createRequest());

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('signup:ip:127.0.0.1');
      expect(resetDistributedRateLimit).toHaveBeenCalledWith('signup:email:user@example.com');
    });

    it('tracks signup and passkey_registered events with masked PII', async () => {
      await POST(createRequest());

      expect(trackAuthEvent).toHaveBeenCalledWith('new-user-1', 'signup', expect.objectContaining({
        email: 'use***@example.com',
        name: 'T***',
        method: 'passkey',
      }));
      expect(trackAuthEvent).toHaveBeenCalledWith('new-user-1', 'passkey_registered', expect.objectContaining({
        passkeyId: 'pk-1',
      }));
    });

    it('generates CSRF token bound to session ID', async () => {
      await POST(createRequest());

      expect(sessionService.validateSession).toHaveBeenCalledWith('ps_sess_mock_session_token');
      expect(generateCSRFToken).toHaveBeenCalledWith('mock-session-id');
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

    it('redirects to /dashboard when drive provisioning returns null', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue(null as never);

      const response = await POST(createRequest());
      const body = await response.json();

      expect(body.redirectUrl).toBe('/dashboard?welcome=true');
    });

    it('does not include Secure flag on CSRF cookie in non-production', async () => {
      vi.stubEnv('NODE_ENV', 'test');

      const response = await POST(createRequest());
      const cookies = response.headers.getSetCookie();
      const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
      expect(csrfCookie).not.toContain('; Secure');

      vi.unstubAllEnvs();
    });

    it('includes Secure flag on CSRF cookie in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      const response = await POST(createRequest());
      const cookies = response.headers.getSetCookie();
      const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
      expect(csrfCookie).toContain('; Secure');

      vi.unstubAllEnvs();
    });
  });

  describe('graceful degradation', () => {
    it('continues when drive provisioning fails', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockRejectedValueOnce(new Error('Drive error'));

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.redirectUrl).toBe('/dashboard?welcome=true');
      expect(loggers.auth.error).toHaveBeenCalledWith('Failed to provision Getting Started drive', new Error('Drive error'), {
        userId: 'new-user-1',
      });
    });

    it('continues when AI settings insertion fails', async () => {
      vi.mocked(oauthRepository.createDefaultAiSettings).mockRejectedValueOnce(new Error('Insert error'));

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(loggers.auth.error).toHaveBeenCalledWith('Failed to insert default AI settings', new Error('Insert error'), {
        userId: 'new-user-1',
      });
    });
  });

  describe('input validation', () => {
    it('returns 400 for missing email', async () => {
      const { email: _, ...payload } = validPayload;
      const response = await POST(createRequest(payload));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
      expect(typeof body.details).toBe('object');
    });

    it('returns 400 for invalid email format', async () => {
      const response = await POST(createRequest({ ...validPayload, email: 'not-email' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 for missing name', async () => {
      const { name: _, ...payload } = validPayload;
      const response = await POST(createRequest(payload));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 for empty name', async () => {
      const response = await POST(createRequest({ ...validPayload, name: '' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 for missing expectedChallenge', async () => {
      const { expectedChallenge: _, ...payload } = validPayload;
      const response = await POST(createRequest(payload));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 for missing csrfToken', async () => {
      const { csrfToken: _, ...payload } = validPayload;
      const response = await POST(createRequest(payload));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 when acceptedTos is false', async () => {
      const response = await POST(createRequest({ ...validPayload, acceptedTos: false }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 when acceptedTos is missing', async () => {
      const { acceptedTos: _, ...payload } = validPayload;
      const response = await POST(createRequest(payload));
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
          riskScore: 0.6,
          details: expect.objectContaining({ reason: 'passkey_csrf_invalid', flow: 'signup' }),
        })
      );
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when IP rate limit exceeded', async () => {
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: false, attemptsRemaining: 0, retryAfter: 3600 });

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toBe('Too many requests from this IP');
      expect(body.retryAfter).toBe(3600);
      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'security.rate.limited',
          riskScore: 0.5,
          details: expect.objectContaining({ reason: 'rate_limit_signup_ip' }),
        })
      );
    });

    it('returns 429 when email rate limit exceeded', async () => {
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 2 })
        .mockResolvedValueOnce({ allowed: false, attemptsRemaining: 0, retryAfter: 3600 });

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toBe('Too many signup attempts for this email');
      expect(body.retryAfter).toBe(3600);
      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'security.rate.limited',
          riskScore: 0.5,
          details: expect.objectContaining({ reason: 'rate_limit_signup_email' }),
        })
      );
    });
  });

  describe('verification errors', () => {
    const errorCases = [
      { code: 'EMAIL_EXISTS', status: 409, message: 'An account with this email already exists' },
      { code: 'CHALLENGE_NOT_FOUND', status: 400, message: 'Challenge not found or invalid' },
      { code: 'CHALLENGE_EXPIRED', status: 400, message: 'Challenge expired, please try again' },
      { code: 'CHALLENGE_ALREADY_USED', status: 400, message: 'Challenge already used' },
      { code: 'VERIFICATION_FAILED', status: 400, message: 'Passkey verification failed' },
      { code: 'VALIDATION_FAILED', status: 400, message: 'Invalid data provided' },
    ];

    errorCases.forEach(({ code, status, message }) => {
      it(`returns ${status} for ${code}`, async () => {
        vi.mocked(verifySignupRegistration).mockResolvedValue({
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
      vi.mocked(verifySignupRegistration).mockResolvedValue({
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

    it('logs verification failures with masked email', async () => {
      vi.mocked(verifySignupRegistration).mockResolvedValue({
        ok: false,
        error: { code: 'VERIFICATION_FAILED', message: 'Error' },
      });

      await POST(createRequest());

      expect(loggers.auth.warn).toHaveBeenCalledWith('Passkey signup failed', expect.objectContaining({
        error: 'VERIFICATION_FAILED',
        email: 'us***@example.com',
      }));
    });
  });

  describe('PII scrub in log metadata', () => {
    const findInfoCall = (msg: string) =>
      vi.mocked(loggers.auth.info).mock.calls.find(call => call[0] === msg);

    it('masks email and omits name in "Passkey signup successful" log', async () => {
      await POST(createRequest());

      const call = findInfoCall('Passkey signup successful');
      expect(call).toBeDefined();
      const meta = call?.[1] as Record<string, unknown>;
      expect(meta.email).toBe('us***@example.com');
      expect(meta).not.toHaveProperty('name');
    });
  });

  describe('session creation errors', () => {
    it('returns 500 when session validation fails after creation', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(null);

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Session creation failed');
      expect(loggers.auth.error).toHaveBeenCalledWith('Failed to validate newly created session', expect.objectContaining({
        userId: 'new-user-1',
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
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Passkey signup verification error',
        new Error('Unexpected'),
        { email: 'us***@example.com', clientIP: '127.0.0.1' },
      );
    });
  });
});
