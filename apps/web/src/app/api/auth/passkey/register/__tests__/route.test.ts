/**
 * Contract tests for POST /api/auth/passkey/register
 *
 * Tests the Request -> Response contract for verifying WebAuthn registration.
 * Requires session authentication and CSRF token.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('@pagespace/lib/auth', () => ({
  verifyRegistration: vi.fn(),
  validateCSRFToken: vi.fn(),
  consumePasskeyRegisterHandoff: vi.fn(),
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

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: {
    PASSKEY_REGISTER: { maxAttempts: 5, windowMs: 300000, progressiveDelay: false },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateSessionRequest: vi.fn(),
  isAuthError: vi.fn(),
  isSessionAuthResult: vi.fn(),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
  getBearerToken: vi.fn((req: Request) => {
    const header = req.headers.get('authorization');
    return header && header.startsWith('Bearer ') ? header.slice(7) : null;
  }),
}));

import { POST } from '../route';
import { verifyRegistration } from '@pagespace/lib/auth/passkey-service'
import { validateCSRFToken } from '@pagespace/lib/auth/csrf-utils'
import { consumePasskeyRegisterHandoff } from '@pagespace/lib/auth/passkey-register-handoff';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { trackAuthEvent } from '@pagespace/lib/monitoring/activity-tracker';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { authenticateSessionRequest, isAuthError, isSessionAuthResult, getClientIP } from '@/lib/auth';
import { NextResponse } from 'next/server';

const validPayload = {
  response: { id: 'cred-1', rawId: 'raw', type: 'public-key' },
  expectedChallenge: 'challenge-123',
  name: 'My Passkey',
};

const createRequest = (body: Record<string, unknown> = validPayload, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/auth/passkey/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': 'valid-csrf-token',
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe('POST /api/auth/passkey/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isSessionAuthResult).mockReturnValue(true);
    vi.mocked(authenticateSessionRequest).mockResolvedValue({
      userId: 'user-1',
      role: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      tokenType: 'session',
      sessionId: 'session-1',
    });
    vi.mocked(validateCSRFToken).mockReturnValue(true);
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: true,
      attemptsRemaining: 4,
    });
    vi.mocked(consumePasskeyRegisterHandoff).mockResolvedValue(null);
  });

  describe('successful registration', () => {
    it('returns 200 with success and passkeyId', async () => {
      vi.mocked(verifyRegistration).mockResolvedValue({
        ok: true,
        data: { passkeyId: 'pk-new-1' },
      });

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.passkeyId).toBe('pk-new-1');
      expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    });

    it('calls verifyRegistration with correct params', async () => {
      vi.mocked(verifyRegistration).mockResolvedValue({
        ok: true,
        data: { passkeyId: 'pk-new-1' },
      });

      await POST(createRequest());

      expect(verifyRegistration).toHaveBeenCalledWith({
        userId: 'user-1',
        response: validPayload.response,
        expectedChallenge: validPayload.expectedChallenge,
        name: 'My Passkey',
      });
    });

    it('handles optional name being undefined', async () => {
      vi.mocked(verifyRegistration).mockResolvedValue({
        ok: true,
        data: { passkeyId: 'pk-new-1' },
      });

      const { name: _, ...payloadWithoutName } = validPayload;
      await POST(createRequest(payloadWithoutName));

      expect(verifyRegistration).toHaveBeenCalledWith(expect.objectContaining({
        name: undefined,
      }));
    });

    it('tracks passkey registration event', async () => {
      vi.mocked(verifyRegistration).mockResolvedValue({
        ok: true,
        data: { passkeyId: 'pk-new-1' },
      });

      await POST(createRequest());

      expect(trackAuthEvent).toHaveBeenCalledWith('user-1', 'passkey_registered', expect.objectContaining({
        ip: '127.0.0.1',
        passkeyId: 'pk-new-1',
        passkeyName: 'My Passkey',
      }));
    });

    it('logs successful registration', async () => {
      vi.mocked(verifyRegistration).mockResolvedValue({
        ok: true,
        data: { passkeyId: 'pk-new-1' },
      });

      await POST(createRequest());

      expect(loggers.auth.info).toHaveBeenCalledWith('Passkey registered successfully', expect.objectContaining({
        userId: 'user-1',
        passkeyId: 'pk-new-1',
      }));
    });

    it('audits passkey token creation on success', async () => {
      vi.mocked(verifyRegistration).mockResolvedValue({
        ok: true,
        data: { passkeyId: 'pk-new-1' },
      });

      await POST(createRequest());

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'auth.token.created',
          userId: 'user-1',
          details: expect.objectContaining({ tokenType: 'passkey' }),
        })
      );
    });
  });

  describe('authentication errors', () => {
    it('returns auth error when not authenticated', async () => {
      const authErrorResponse = NextResponse.json({ error: 'Authentication required' }, { status: 401 });
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateSessionRequest).mockResolvedValue({ error: authErrorResponse });

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Authentication required');
    });
  });

  describe('CSRF validation', () => {
    it('returns 403 when CSRF token is invalid', async () => {
      vi.mocked(validateCSRFToken).mockReturnValue(false);

      const response = await POST(createRequest(validPayload, { 'x-csrf-token': 'bad' }));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Invalid CSRF token');
      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'security.suspicious.activity',
          details: expect.objectContaining({ reason: 'passkey_csrf_invalid', flow: 'register' }),
          riskScore: 0.6,
        })
      );
    });

    it('returns 403 when CSRF token is missing', async () => {
      vi.mocked(validateCSRFToken).mockReturnValue(false);

      const request = new Request('http://localhost/api/auth/passkey/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Invalid CSRF token');
    });

    it('does NOT skip CSRF when Authorization uses a non-Bearer scheme (e.g. Basic)', async () => {
      vi.mocked(validateCSRFToken).mockReturnValue(false);

      const response = await POST(
        createRequest(validPayload, {
          Authorization: 'Basic dXNlcjpwYXNz',
          'x-csrf-token': 'bad',
        })
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Invalid CSRF token');
    });

    it('skips CSRF validation for Bearer token auth', async () => {
      vi.mocked(isSessionAuthResult).mockReturnValue(true);
      vi.mocked(validateCSRFToken).mockReturnValue(false);
      vi.mocked(verifyRegistration).mockResolvedValue({
        ok: true,
        data: { passkeyId: 'pk-new-1' },
      });

      const response = await POST(createRequest(validPayload, { 'Authorization': 'Bearer ps_sess_token' }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('skips CSRF validation when sessionId is null', async () => {
      vi.mocked(isSessionAuthResult).mockReturnValue(true);
      vi.mocked(authenticateSessionRequest).mockResolvedValue({
        userId: 'user-1',
        role: 'user',
        tokenVersion: 0,
        adminRoleVersion: 0,
        tokenType: 'session',
        sessionId: undefined as unknown as string,
      });
      vi.mocked(verifyRegistration).mockResolvedValue({
        ok: true,
        data: { passkeyId: 'pk-new-1' },
      });

      const request = new Request('http://localhost/api/auth/passkey/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(validateCSRFToken).not.toHaveBeenCalled();
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
          userId: 'user-1',
          details: expect.objectContaining({ reason: 'passkey_rate_limit_register' }),
          riskScore: 0.5,
        })
      );
    });

    it('session-authed path calls checkDistributedRateLimit exactly once with passkey_register:<userId>', async () => {
      vi.mocked(verifyRegistration).mockResolvedValue({
        ok: true,
        data: { passkeyId: 'pk-new-1' },
      });

      await POST(createRequest());

      expect(checkDistributedRateLimit).toHaveBeenCalledTimes(1);
      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'passkey_register:user-1',
        expect.any(Object)
      );
    });
  });

  describe('input validation', () => {
    it('returns 400 (not 500) when the request body is malformed JSON', async () => {
      const request = new Request('http://localhost/api/auth/passkey/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': 'valid-csrf-token',
        },
        body: 'not-json{',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
      expect(authenticateSessionRequest).not.toHaveBeenCalled();
    });

    it('returns 400 for missing expectedChallenge', async () => {
      const response = await POST(createRequest({ response: {} }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
      expect(typeof body.details).toBe('object');
    });

    it('returns 400 for empty expectedChallenge', async () => {
      const response = await POST(createRequest({ response: {}, expectedChallenge: '' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 for name exceeding 255 characters', async () => {
      const response = await POST(createRequest({
        response: {},
        expectedChallenge: 'ch',
        name: 'a'.repeat(256),
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });
  });

  describe('verification errors', () => {
    const errorCases = [
      { code: 'CHALLENGE_NOT_FOUND', status: 400, message: 'Challenge not found or invalid' },
      { code: 'CHALLENGE_EXPIRED', status: 400, message: 'Challenge expired, please try again' },
      { code: 'CHALLENGE_ALREADY_USED', status: 400, message: 'Challenge already used' },
      { code: 'VERIFICATION_FAILED', status: 400, message: 'Verification failed' },
      { code: 'VALIDATION_FAILED', status: 400, message: 'Validation failed' },
    ];

    errorCases.forEach(({ code, status, message }) => {
      it(`returns ${status} for ${code}`, async () => {
        vi.mocked(verifyRegistration).mockResolvedValue({
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
      vi.mocked(verifyRegistration).mockResolvedValue({
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

    it('logs verification failures', async () => {
      vi.mocked(verifyRegistration).mockResolvedValue({
        ok: false,
        error: { code: 'VERIFICATION_FAILED', message: 'Error' },
      });

      await POST(createRequest());

      expect(loggers.auth.warn).toHaveBeenCalledWith('Passkey registration verification failed', expect.objectContaining({
        error: 'VERIFICATION_FAILED',
      }));
    });
  });

  describe('desktop handoff-token branch', () => {
    const handoffPayload = {
      handoffToken: 'good-token',
      response: { id: 'cred-1', rawId: 'raw', type: 'public-key' },
      expectedChallenge: 'challenge-123',
      name: 'Handoff Passkey',
    };

    const handoffRequest = () =>
      new Request('http://localhost/api/auth/passkey/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(handoffPayload),
      });

    it('accepts a valid handoff token without session auth or CSRF and registers passkey', async () => {
      vi.mocked(consumePasskeyRegisterHandoff).mockResolvedValue({
        userId: 'user-handoff',
        createdAt: Date.now(),
      });
      vi.mocked(verifyRegistration).mockResolvedValue({
        ok: true,
        data: { passkeyId: 'pk-handoff-1' },
      });

      const response = await POST(handoffRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.passkeyId).toBe('pk-handoff-1');
      expect(consumePasskeyRegisterHandoff).toHaveBeenCalledWith('good-token');
      expect(authenticateSessionRequest).not.toHaveBeenCalled();
      expect(validateCSRFToken).not.toHaveBeenCalled();
      expect(verifyRegistration).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-handoff', name: 'Handoff Passkey' })
      );
    });

    it('returns 401 with HANDOFF_INVALID and audits when handoff is already consumed', async () => {
      vi.mocked(consumePasskeyRegisterHandoff).mockResolvedValue(null);

      const response = await POST(handoffRequest());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.code).toBe('HANDOFF_INVALID');
      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'security.suspicious.activity',
          details: expect.objectContaining({
            reason: 'passkey_handoff_invalid',
            flow: 'register',
          }),
        })
      );
      expect(verifyRegistration).not.toHaveBeenCalled();
    });

    it('enforces one-time-use — a second call with the same token is rejected', async () => {
      vi.mocked(consumePasskeyRegisterHandoff)
        .mockResolvedValueOnce({ userId: 'user-handoff', createdAt: Date.now() })
        .mockResolvedValueOnce(null);
      vi.mocked(verifyRegistration).mockResolvedValue({
        ok: true,
        data: { passkeyId: 'pk-handoff-1' },
      });

      const first = await POST(handoffRequest());
      expect(first.status).toBe(200);

      const second = await POST(handoffRequest());
      expect(second.status).toBe(401);
      const body = await second.json();
      expect(body.code).toBe('HANDOFF_INVALID');
    });

    it('does NOT call checkDistributedRateLimit on the handoff path (consume + TTL + one-time-use is the rate bound)', async () => {
      vi.mocked(consumePasskeyRegisterHandoff).mockResolvedValue({
        userId: 'user-handoff',
        createdAt: Date.now(),
      });
      vi.mocked(verifyRegistration).mockResolvedValue({
        ok: true,
        data: { passkeyId: 'pk-handoff-1' },
      });

      const response = await POST(handoffRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.passkeyId).toBe('pk-handoff-1');
      expect(checkDistributedRateLimit).not.toHaveBeenCalled();
    });

    it('three back-to-back handoff verifies for the same user all return 200 — the bucket no longer gates desktop', async () => {
      vi.mocked(consumePasskeyRegisterHandoff)
        .mockResolvedValueOnce({ userId: 'user-handoff', createdAt: Date.now() })
        .mockResolvedValueOnce({ userId: 'user-handoff', createdAt: Date.now() })
        .mockResolvedValueOnce({ userId: 'user-handoff', createdAt: Date.now() });
      vi.mocked(verifyRegistration).mockResolvedValue({
        ok: true,
        data: { passkeyId: 'pk-handoff' },
      });

      const req1 = new Request('http://localhost/api/auth/passkey/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...handoffPayload, handoffToken: 'token-1' }),
      });
      const req2 = new Request('http://localhost/api/auth/passkey/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...handoffPayload, handoffToken: 'token-2' }),
      });
      const req3 = new Request('http://localhost/api/auth/passkey/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...handoffPayload, handoffToken: 'token-3' }),
      });

      const r1 = await POST(req1);
      const r2 = await POST(req2);
      const r3 = await POST(req3);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);
      expect(checkDistributedRateLimit).not.toHaveBeenCalled();
    });
  });

  describe('unexpected errors', () => {
    it('returns 500 on unexpected throw', async () => {
      vi.mocked(authenticateSessionRequest).mockRejectedValueOnce(new Error('Unexpected'));

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
      expect(loggers.auth.error).toHaveBeenCalledWith('Passkey registration verification error', new Error('Unexpected'));
    });
  });
});
