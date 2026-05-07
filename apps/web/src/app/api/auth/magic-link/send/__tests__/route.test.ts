/**
 * Contract tests for POST /api/auth/magic-link/send
 *
 * Coverage:
 * - CSRF token validation (missing header/cookie, mismatch, invalid)
 * - Request body validation (invalid JSON, schema validation)
 * - Rate limiting by IP and email
 * - requestMagicLink pipe outcomes (success, suspended, no account, throw)
 * - Email enumeration prevention (always same success response)
 * - Error handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    attemptsRemaining: 4,
    retryAfter: undefined,
  }),
  DISTRIBUTED_RATE_LIMITS: {
    MAGIC_LINK: { maxAttempts: 5, windowMs: 900000, progressiveDelay: false },
  },
}));

const { pipeInner, pipeFactory } = vi.hoisted(() => {
  const inner = vi.fn();
  return { pipeInner: inner, pipeFactory: vi.fn(() => inner) };
});

vi.mock('@pagespace/lib/services/invites', () => ({
  requestMagicLink: pipeFactory,
}));

vi.mock('@/lib/auth/magic-link-adapters', () => ({
  buildMagicLinkPorts: vi.fn(() => ({})),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/mask-email', () => ({
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

import { POST } from '../route';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
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
    pipeFactory.mockReturnValue(pipeInner);
    pipeInner.mockResolvedValue({ ok: true });
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
          eventType: 'security.suspicious.activity',
          details: expect.objectContaining({ reason: 'magic_link_csrf_missing' }),
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
          eventType: 'security.suspicious.activity',
          details: expect.objectContaining({ reason: 'magic_link_csrf_mismatch' }),
          riskScore: 0.6,
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
          eventType: 'security.suspicious.activity',
          details: expect.objectContaining({ reason: 'magic_link_csrf_invalid' }),
          riskScore: 0.6,
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
    });

    it('uses default Retry-After when retryAfter is undefined for IP', async () => {
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: false, attemptsRemaining: 0, retryAfter: undefined })
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 4, retryAfter: undefined });

      const response = await POST(createMagicLinkRequest());

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

  describe('requestMagicLink pipe outcomes', () => {
    it('given a successful pipe call, returns generic 200 + audits auth.token.created', async () => {
      pipeInner.mockResolvedValue({ ok: true });

      const request = createMagicLinkRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toContain('If an account exists');
      expect(auditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'auth.token.created',
          details: expect.objectContaining({ tokenType: 'magic_link' }),
        }),
      );
      expect(loggers.auth.info).toHaveBeenCalledWith(
        'Magic link email sent',
        { email: 'te***@example.com', ip: '127.0.0.1' },
      );
    });

    it('given the pipe returns ACCOUNT_SUSPENDED, returns generic 200 + audits the failure (enumeration mask)', async () => {
      pipeInner.mockResolvedValue({ ok: false, error: 'ACCOUNT_SUSPENDED' });

      const request = createMagicLinkRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toContain('If an account exists');
      expect(auditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'auth.login.failure',
          details: expect.objectContaining({ reason: 'magic_link_user_suspended' }),
          riskScore: 0.5,
        }),
      );
      // No success-side audit
      expect(auditRequest).not.toHaveBeenCalledWith(
        request,
        expect.objectContaining({ eventType: 'auth.token.created' }),
      );
    });

    it('given the pipe returns NO_ACCOUNT_FOUND, returns 404 + the structured no_account payload (signup CTA)', async () => {
      pipeInner.mockResolvedValue({ ok: false, error: 'NO_ACCOUNT_FOUND' });

      const request = createMagicLinkRequest({ email: 'unknown@example.com' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body).toEqual({ code: 'no_account', email: 'unknown@example.com' });
      expect(auditRequest).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          eventType: 'auth.login.failure',
          details: expect.objectContaining({ reason: 'magic_link_no_account_found' }),
          riskScore: 0.2,
        }),
      );
    });

    it('given the pipe throws (e.g. SMTP failure inside the email-send port), returns generic 200 + logs (preserves enumeration resistance)', async () => {
      pipeInner.mockRejectedValue(new Error('SMTP unavailable'));

      const request = createMagicLinkRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toContain('If an account exists');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Magic link pipe threw',
        expect.any(Error),
        expect.objectContaining({ email: 'te***@example.com' }),
      );
    });

    it('given the pipe is invoked, the email is normalized + a Date now is forwarded', async () => {
      const request = createMagicLinkRequest({ email: 'TEST@Example.COM' });
      await POST(request);

      expect(pipeInner).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'test@example.com',
          now: expect.any(Date),
        }),
      );
    });
  });

  describe('next= forwarding', () => {
    it('given a safe next path on the body, forwards next to the pipe input', async () => {
      const request = createMagicLinkRequest({
        email: 'test@example.com',
        next: '/dashboard/drive_abc',
      });
      await POST(request);

      expect(pipeInner).toHaveBeenCalledWith(
        expect.objectContaining({ next: '/dashboard/drive_abc' }),
      );
    });

    it('given a safe /invite/<token> next path on the body, forwards next to the pipe input', async () => {
      const request = createMagicLinkRequest({
        email: 'test@example.com',
        next: '/invite/abc123',
      });
      await POST(request);

      expect(pipeInner).toHaveBeenCalledWith(
        expect.objectContaining({ next: '/invite/abc123' }),
      );
    });

    it('given a protocol-relative next (//evil.com), strips it before forwarding (defense in depth)', async () => {
      const request = createMagicLinkRequest({
        email: 'test@example.com',
        next: '//evil.com/phish',
      });
      const response = await POST(request);

      expect(response.status).toBe(200);
      const callArgs = pipeInner.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs).toBeDefined();
      expect(callArgs).not.toHaveProperty('next');
    });

    it('given a next outside the allowlist (/admin), strips it before forwarding', async () => {
      const request = createMagicLinkRequest({
        email: 'test@example.com',
        next: '/admin/settings',
      });
      const response = await POST(request);

      expect(response.status).toBe(200);
      const callArgs = pipeInner.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs).toBeDefined();
      expect(callArgs).not.toHaveProperty('next');
    });

    it('given no next on the body, does not forward next to the pipe', async () => {
      const request = createMagicLinkRequest({ email: 'test@example.com' });
      await POST(request);

      const callArgs = pipeInner.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs).toBeDefined();
      expect(callArgs).not.toHaveProperty('next');
    });

    it('given a next longer than 2048 chars, returns 400 (zod schema rejects)', async () => {
      const tooLong = '/dashboard/' + 'a'.repeat(2050);
      const request = createMagicLinkRequest({
        email: 'test@example.com',
        next: tooLong,
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
      expect(pipeInner).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected errors (rate-limit throws)', async () => {
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
