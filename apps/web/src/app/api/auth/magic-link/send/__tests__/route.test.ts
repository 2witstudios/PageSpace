/**
 * Contract tests for POST /api/auth/magic-link/send
 *
 * Coverage:
 * - CSRF token validation (missing header/cookie, mismatch, invalid)
 * - Request body validation (invalid JSON, schema validation)
 * - Rate limiting by IP and email
 * - Magic link creation (success, suspended user, validation error, generic error)
 * - Email sending (success and failure)
 * - Email enumeration prevention (always same success response)
 * - Error handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies BEFORE imports
vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    attemptsRemaining: 4,
    retryAfter: undefined,
  }),
  DISTRIBUTED_RATE_LIMITS: {
    MAGIC_LINK: { maxAttempts: 5, windowMs: 900000, progressiveDelay: false },
  },
}));

vi.mock('@pagespace/lib/auth/magic-link-service', () => ({
  createMagicLinkToken: vi.fn().mockResolvedValue({
    ok: true,
    data: { token: 'mock-magic-token', isNewUser: false },
  }),
}));

vi.mock('@pagespace/lib/services/email-service', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/email-templates/MagicLinkEmail', () => ({
  MagicLinkEmail: vi.fn(),
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
  maskEmail: (email: string) => {
    const [local, domain] = email.split('@');
    if (!local || !domain) return '***@***';
    return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
  },
}));

vi.mock('@/lib/auth', () => ({
  validateLoginCSRFToken: vi.fn().mockReturnValue(true),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('cookie', () => ({
  parse: vi.fn().mockReturnValue({ login_csrf: 'valid-csrf-token' }),
}));

vi.mock('react', () => ({
  default: {
    createElement: vi.fn().mockReturnValue({}),
  },
}));

import { POST } from '../route';
import { checkDistributedRateLimit } from '@pagespace/lib/security';
import { createMagicLinkToken } from '@pagespace/lib/auth/magic-link-service';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { loggers, auditRequest } from '@pagespace/lib/server';
import { validateLoginCSRFToken, getClientIP } from '@/lib/auth';
import { parse } from 'cookie';

const createMagicLinkRequest = (
  body: Record<string, unknown> | string = { email: 'test@example.com' },
  headers: Record<string, string> = {}
) => {
  const defaultHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Login-CSRF-Token': 'valid-csrf-token',
    'Cookie': 'login_csrf=valid-csrf-token',
    ...headers,
  };

  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

  return new Request('http://localhost/api/auth/magic-link/send', {
    method: 'POST',
    headers: defaultHeaders,
    body: bodyStr,
  });
};

describe('POST /api/auth/magic-link/send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(validateLoginCSRFToken).mockReturnValue(true);
    vi.mocked(parse).mockReturnValue({ login_csrf: 'valid-csrf-token' });
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: true,
      attemptsRemaining: 4,
      retryAfter: undefined,
    });
    vi.mocked(createMagicLinkToken).mockResolvedValue({
      ok: true,
      // @ts-expect-error - partial mock data
      data: { token: 'mock-magic-token', isNewUser: false },
    });
  });

  describe('CSRF validation', () => {
    it('returns 403 when CSRF header is missing', async () => {
      const request = new Request('http://localhost/api/auth/magic-link/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'login_csrf=valid-csrf-token',
        },
        body: JSON.stringify({ email: 'test@example.com' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('CSRF token required');
      expect(body.code).toBe('LOGIN_CSRF_MISSING');
      expect(auditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'security.anomaly.detected',
          details: expect.objectContaining({ originalEvent: 'magic_link_csrf_missing' }),
          riskScore: 0.4,
        })
      );
    });

    it('returns 403 when CSRF cookie is missing', async () => {
      vi.mocked(parse).mockReturnValue({});

      const request = new Request('http://localhost/api/auth/magic-link/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Login-CSRF-Token': 'valid-csrf-token',
        },
        body: JSON.stringify({ email: 'test@example.com' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.code).toBe('LOGIN_CSRF_MISSING');
    });

    it('returns 403 when CSRF header and cookie do not match', async () => {
      vi.mocked(parse).mockReturnValue({ login_csrf: 'different-token' });

      const request = createMagicLinkRequest();

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Invalid CSRF token');
      expect(body.code).toBe('LOGIN_CSRF_MISMATCH');
      expect(auditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'security.anomaly.detected',
          details: expect.objectContaining({ originalEvent: 'magic_link_csrf_mismatch' }),
          riskScore: 0.5,
        })
      );
    });

    it('returns 403 when CSRF token validation fails', async () => {
      vi.mocked(validateLoginCSRFToken).mockReturnValue(false);

      const request = createMagicLinkRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Invalid or expired CSRF token');
      expect(body.code).toBe('LOGIN_CSRF_INVALID');
      expect(auditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'security.anomaly.detected',
          details: expect.objectContaining({ originalEvent: 'magic_link_csrf_invalid' }),
          riskScore: 0.5,
        })
      );
    });
  });

  describe('request body validation', () => {
    it('returns 400 for invalid JSON body', async () => {
      const request = new Request('http://localhost/api/auth/magic-link/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Login-CSRF-Token': 'valid-csrf-token',
          'Cookie': 'login_csrf=valid-csrf-token',
        },
        body: 'not-json{{{',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 for invalid email format', async () => {
      const request = createMagicLinkRequest({ email: 'not-an-email' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.email).toEqual(['Please enter a valid email address']);
    });

    it('returns 400 for missing email', async () => {
      const request = createMagicLinkRequest({});
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.email).toEqual(['Please enter a valid email address']);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when IP rate limit exceeded', async () => {
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: false, attemptsRemaining: 0, retryAfter: 600 })
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 4, retryAfter: undefined });

      const request = createMagicLinkRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many requests');
      expect(body.retryAfter).toBe(600);
      expect(response.headers.get('Retry-After')).toBe('600');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(auditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'security.rate.limited',
          details: expect.objectContaining({ originalEvent: 'magic_link_rate_limit_ip' }),
          riskScore: 0.4,
        })
      );
    });

    it('returns 429 when email rate limit exceeded', async () => {
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 4, retryAfter: undefined })
        .mockResolvedValueOnce({ allowed: false, attemptsRemaining: 0, retryAfter: 300 });

      const request = createMagicLinkRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many requests for this email');
      expect(body.retryAfter).toBe(300);
      expect(auditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'security.rate.limited',
          details: expect.objectContaining({ originalEvent: 'magic_link_rate_limit_email', email: 'te***@example.com' }),
          riskScore: 0.4,
        })
      );
    });

    it('uses default Retry-After when retryAfter is undefined for IP', async () => {
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: false, attemptsRemaining: 0, retryAfter: undefined })
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 4, retryAfter: undefined });

      const request = createMagicLinkRequest();
      const response = await POST(request);

      expect(response.headers.get('Retry-After')).toBe('900');
    });

    it('uses default Retry-After when retryAfter is undefined for email', async () => {
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 4, retryAfter: undefined })
        .mockResolvedValueOnce({ allowed: false, attemptsRemaining: 0, retryAfter: undefined });

      const request = createMagicLinkRequest();
      const response = await POST(request);

      expect(response.headers.get('Retry-After')).toBe('900');
    });

    it('normalizes email to lowercase for rate limiting', async () => {
      const request = createMagicLinkRequest({ email: 'TEST@Example.COM' });
      await POST(request);

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'magic_link:email:test@example.com',
        { maxAttempts: 5, windowMs: 900000, progressiveDelay: false }
      );
    });
  });

  describe('magic link creation', () => {
    it('returns success message on successful creation', async () => {
      const request = createMagicLinkRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toContain('If an account exists');
    });

    it('returns success without sending email for suspended users', async () => {
      vi.mocked(createMagicLinkToken).mockResolvedValue({
        ok: false,
        // @ts-expect-error - test mock with extra properties
        error: { code: 'USER_SUSPENDED', message: 'Account suspended' },
      });

      const request = createMagicLinkRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toContain('If an account exists');
      expect(sendEmail).not.toHaveBeenCalled();
      expect(auditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'auth.login.failure',
          details: expect.objectContaining({
            attemptedUser: 'te***@example.com',
            reason: 'user_suspended',
          }),
          riskScore: 0.5,
        })
      );
    });

    it('returns 400 for validation errors from service', async () => {
      vi.mocked(createMagicLinkToken).mockResolvedValue({
        ok: false,
        error: { code: 'VALIDATION_FAILED', message: 'Email domain not allowed' },
      });

      const request = createMagicLinkRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Email domain not allowed');
    });

    it('returns generic success for other service errors', async () => {
      vi.mocked(createMagicLinkToken).mockResolvedValue({
        ok: false,
        // @ts-expect-error - partial mock data
        error: { code: 'DATABASE_ERROR', message: 'Connection failed' },
      });

      const request = createMagicLinkRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toContain('If an account exists');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Magic link creation failed',
        { error: { code: 'DATABASE_ERROR', message: 'Connection failed' } }
      );
    });

    it('audits unexpected service errors via auditRequest', async () => {
      vi.mocked(createMagicLinkToken).mockResolvedValue({
        ok: false,
        // @ts-expect-error - partial mock data
        error: { code: 'DATABASE_ERROR', message: 'Connection failed' },
      });

      const request = createMagicLinkRequest();
      await POST(request);

      expect(auditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'auth.login.failure',
          details: expect.objectContaining({
            reason: 'magic_link_database_error',
          }),
        })
      );
    });
  });

  describe('email sending', () => {
    it('sends magic link email on success', async () => {
      const request = createMagicLinkRequest({ email: 'user@example.com' });
      await POST(request);

      const sendArgs = vi.mocked(sendEmail).mock.calls[0][0];
      expect(sendArgs.to).toBe('user@example.com');
      expect(sendArgs.subject).toBe('Sign in to PageSpace');
    });

    it('logs successful email send', async () => {
      const request = createMagicLinkRequest();
      await POST(request);

      expect(loggers.auth.info).toHaveBeenCalledWith(
        'Magic link email sent',
        {
          email: 'te***@example.com',
          isNewUser: false,
          ip: '127.0.0.1',
        }
      );
    });

    it('audits magic link token creation on successful email send', async () => {
      const request = createMagicLinkRequest();
      await POST(request);

      expect(auditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'auth.token.created',
          details: expect.objectContaining({
            tokenType: 'magic_link',
            email: 'te***@example.com',
          }),
        })
      );
    });

    it('returns success even when email sending fails', async () => {
      vi.mocked(sendEmail).mockRejectedValueOnce(new Error('SMTP error'));

      const request = createMagicLinkRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toContain('If an account exists');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Failed to send magic link email',
        new Error('SMTP error'),
        { email: 'te***@example.com' }
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      vi.mocked(checkDistributedRateLimit).mockRejectedValueOnce(new Error('Redis down'));

      const request = createMagicLinkRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred.');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Magic link send error',
        new Error('Redis down')
      );
    });
  });
});
