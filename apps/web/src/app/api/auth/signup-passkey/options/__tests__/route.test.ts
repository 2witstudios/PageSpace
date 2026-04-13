/**
 * Contract tests for POST /api/auth/signup-passkey/options
 *
 * Tests the Request -> Response contract for generating WebAuthn registration options for signup.
 * Public endpoint (unauthenticated) - requires login CSRF token.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('@pagespace/lib/auth', () => ({
  generateRegistrationOptionsForSignup: vi.fn(),
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

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: {
    SIGNUP: { maxAttempts: 3, windowMs: 3600000, progressiveDelay: false },
  },
}));

vi.mock('@/lib/auth', () => ({
  validateLoginCSRFToken: vi.fn(),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

import { POST } from '../route';
import { generateRegistrationOptionsForSignup } from '@pagespace/lib/auth';
import { loggers, auditRequest } from '@pagespace/lib/server';
import { checkDistributedRateLimit } from '@pagespace/lib/security';
import { validateLoginCSRFToken, getClientIP } from '@/lib/auth';

const validPayload = {
  email: 'user@example.com',
  name: 'Test User',
  csrfToken: 'valid-csrf',
};

const createRequest = (body: Record<string, unknown> = validPayload) =>
  new Request('http://localhost/api/auth/signup-passkey/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/auth/signup-passkey/options', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: true,
      attemptsRemaining: 2,
    });
    vi.mocked(validateLoginCSRFToken).mockReturnValue(true);
  });

  describe('successful options generation', () => {
    it('returns 200 with options and challengeId', async () => {
      const mockOptions = { challenge: 'abc', rp: { name: 'PageSpace' } };
      vi.mocked(generateRegistrationOptionsForSignup).mockResolvedValue({
        ok: true,
        // @ts-expect-error - partial mock data
        data: { options: mockOptions, challengeId: 'ch-1' },
      });

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.options).toEqual(mockOptions);
      expect(body.challengeId).toBe('ch-1');
      expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    });

    it('normalizes email to lowercase before calling service', async () => {
      vi.mocked(generateRegistrationOptionsForSignup).mockResolvedValue({
        ok: true,
        // @ts-expect-error - partial mock data
        data: { options: {}, challengeId: 'ch-1' },
      });

      await POST(createRequest({ ...validPayload, email: 'USER@EXAMPLE.COM' }));

      expect(generateRegistrationOptionsForSignup).toHaveBeenCalledWith({
        email: 'user@example.com',
        name: 'Test User',
      });
    });

    it('logs options generation with masked email', async () => {
      vi.mocked(generateRegistrationOptionsForSignup).mockResolvedValue({
        ok: true,
        // @ts-expect-error - partial mock data
        data: { options: {}, challengeId: 'ch-1' },
      });

      await POST(createRequest());

      expect(loggers.auth.info).toHaveBeenCalledWith('Passkey signup options generated', expect.objectContaining({
        email: 'use***',
      }));
    });
  });

  describe('input validation', () => {
    it('returns 400 for missing email', async () => {
      const response = await POST(createRequest({ name: 'Test', csrfToken: 'valid' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
      expect(typeof body.details).toBe('object');
    });

    it('returns 400 for invalid email format', async () => {
      const response = await POST(createRequest({ email: 'not-email', name: 'Test', csrfToken: 'valid' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 for missing name', async () => {
      const response = await POST(createRequest({ email: 'user@example.com', csrfToken: 'valid' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 for empty name', async () => {
      const response = await POST(createRequest({ email: 'user@example.com', name: '', csrfToken: 'valid' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 for name exceeding 255 characters', async () => {
      const response = await POST(createRequest({
        email: 'user@example.com',
        name: 'a'.repeat(256),
        csrfToken: 'valid',
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 for missing csrfToken', async () => {
      const response = await POST(createRequest({ email: 'user@example.com', name: 'Test' }));
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
          details: expect.objectContaining({ reason: 'passkey_csrf_invalid', flow: 'signup_options' }),
          riskScore: 0.6,
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
          details: expect.objectContaining({ reason: 'rate_limit_signup_options_ip' }),
          riskScore: 0.5,
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
          details: expect.objectContaining({ reason: 'rate_limit_signup_options_email' }),
          riskScore: 0.5,
        })
      );
    });
  });

  describe('service errors', () => {
    it('returns 409 when email already exists', async () => {
      vi.mocked(generateRegistrationOptionsForSignup).mockResolvedValue({
        ok: false,
        // @ts-expect-error - test mock with extra properties
        error: { code: 'EMAIL_EXISTS', message: 'Email exists' },
      });

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe('An account with this email already exists');
      expect(body.code).toBe('EMAIL_EXISTS');
      expect(loggers.auth.info).toHaveBeenCalledWith('Passkey signup - email already exists', expect.objectContaining({
        email: 'use***',
      }));
    });

    it('returns 400 for validation failure', async () => {
      vi.mocked(generateRegistrationOptionsForSignup).mockResolvedValue({
        ok: false,
        error: { code: 'VALIDATION_FAILED', message: 'Invalid data' },
      });

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid data provided');
      expect(body.code).toBe('VALIDATION_FAILED');
    });

    it('returns 500 for unknown error code', async () => {
      vi.mocked(generateRegistrationOptionsForSignup).mockResolvedValue({
        ok: false,
        // @ts-expect-error - partial mock data
        error: { code: 'UNKNOWN_ERROR', message: 'Something' },
      });

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to generate options');
      expect(loggers.auth.warn).toHaveBeenCalledWith('Passkey signup options failed', expect.objectContaining({
        error: 'UNKNOWN_ERROR',
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
      expect(loggers.auth.error).toHaveBeenCalledWith('Passkey signup options error', new Error('Unexpected'));
    });
  });
});
