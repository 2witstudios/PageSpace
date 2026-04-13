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
  DISTRIBUTED_RATE_LIMITS: {
    PASSKEY_REGISTER: { maxAttempts: 5, windowMs: 300000, progressiveDelay: false },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateSessionRequest: vi.fn(),
  isAuthError: vi.fn(),
  isSessionAuthResult: vi.fn(),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

import { POST } from '../route';
import { verifyRegistration, validateCSRFToken } from '@pagespace/lib/auth';
import { loggers, auditRequest } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { checkDistributedRateLimit } from '@pagespace/lib/security';
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
          eventType: 'security.anomaly.detected',
          details: expect.objectContaining({ originalEvent: 'passkey_csrf_invalid', flow: 'register' }),
          riskScore: 0.4,
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
          details: expect.objectContaining({ originalEvent: 'passkey_rate_limit_register', retryAfter: 300 }),
          riskScore: 0.4,
        })
      );
    });
  });

  describe('input validation', () => {
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
