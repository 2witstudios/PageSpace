/**
 * Contract tests for POST /api/auth/passkey/authenticate/options
 *
 * Tests the Request -> Response contract for generating WebAuthn authentication options.
 * Public endpoint (unauthenticated) - requires login CSRF token.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('@pagespace/lib/auth', () => ({
  generateAuthenticationOptions: vi.fn(),
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
  logSecurityEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: {
    PASSKEY_OPTIONS: { maxAttempts: 10, windowMs: 60000, progressiveDelay: false },
  },
}));

vi.mock('@/lib/auth', () => ({
  validateLoginCSRFToken: vi.fn(),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

import { POST } from '../route';
import { generateAuthenticationOptions } from '@pagespace/lib/auth';
import { loggers, logSecurityEvent } from '@pagespace/lib/server';
import { checkDistributedRateLimit } from '@pagespace/lib/security';
import { validateLoginCSRFToken, getClientIP } from '@/lib/auth';

const createRequest = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/auth/passkey/authenticate/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/auth/passkey/authenticate/options', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: true,
      attemptsRemaining: 9,
    });
    vi.mocked(validateLoginCSRFToken).mockReturnValue(true);
  });

  describe('successful options generation', () => {
    it('returns 200 with options and challengeId', async () => {
      const mockOptions = { challenge: 'abc123', rpId: 'localhost' };
      vi.mocked(generateAuthenticationOptions).mockResolvedValue({
        ok: true,
        data: { options: mockOptions, challengeId: 'ch-1' },
      });

      const response = await POST(createRequest({ csrfToken: 'valid' }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.options).toEqual(mockOptions);
      expect(body.challengeId).toBe('ch-1');
      expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    });

    it('passes email to generateAuthenticationOptions when provided', async () => {
      vi.mocked(generateAuthenticationOptions).mockResolvedValue({
        ok: true,
        // @ts-expect-error - partial mock data
        data: { options: {}, challengeId: 'ch-1' },
      });

      await POST(createRequest({ csrfToken: 'valid', email: 'user@example.com' }));

      expect(generateAuthenticationOptions).toHaveBeenCalledWith({ email: 'user@example.com' });
    });

    it('passes undefined email when not provided', async () => {
      vi.mocked(generateAuthenticationOptions).mockResolvedValue({
        ok: true,
        // @ts-expect-error - partial mock data
        data: { options: {}, challengeId: 'ch-1' },
      });

      await POST(createRequest({ csrfToken: 'valid' }));

      expect(generateAuthenticationOptions).toHaveBeenCalledWith({ email: undefined });
    });

    it('logs options generation with hasEmail flag', async () => {
      vi.mocked(generateAuthenticationOptions).mockResolvedValue({
        ok: true,
        // @ts-expect-error - partial mock data
        data: { options: {}, challengeId: 'ch-1' },
      });

      await POST(createRequest({ csrfToken: 'valid', email: 'user@example.com' }));

      expect(loggers.auth.info).toHaveBeenCalledWith('Passkey auth options generated', expect.objectContaining({
        hasEmail: true,
      }));
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when rate limited', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 60,
      });

      const response = await POST(createRequest({ csrfToken: 'valid' }));
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toBe('Too many requests');
      expect(body.retryAfter).toBe(60);
      expect(logSecurityEvent).toHaveBeenCalledWith('passkey_rate_limit_options', expect.objectContaining({
        retryAfter: 60,
      }));
    });

    it('does not proceed to validation when rate limited', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 60,
      });

      await POST(createRequest({ csrfToken: 'valid' }));

      expect(generateAuthenticationOptions).not.toHaveBeenCalled();
    });
  });

  describe('input validation', () => {
    it('returns 400 for missing csrfToken', async () => {
      const response = await POST(createRequest({}));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
      expect(typeof body.details).toBe('object');
    });

    it('returns 400 for empty csrfToken', async () => {
      const response = await POST(createRequest({ csrfToken: '' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 for invalid email format', async () => {
      const response = await POST(createRequest({ csrfToken: 'valid', email: 'not-email' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });
  });

  describe('CSRF validation', () => {
    it('returns 403 when CSRF token is invalid', async () => {
      vi.mocked(validateLoginCSRFToken).mockReturnValue(false);

      const response = await POST(createRequest({ csrfToken: 'bad-token' }));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Invalid CSRF token');
      expect(logSecurityEvent).toHaveBeenCalledWith('passkey_csrf_invalid', expect.objectContaining({
        flow: 'authenticate_options',
      }));
    });

    it('masks email in CSRF security event when email is provided', async () => {
      vi.mocked(validateLoginCSRFToken).mockReturnValue(false);

      await POST(createRequest({ csrfToken: 'bad', email: 'user@example.com' }));

      expect(logSecurityEvent).toHaveBeenCalledWith('passkey_csrf_invalid', expect.objectContaining({
        email: 'use***',
      }));
    });

    it('does not include email in CSRF security event when email is not provided', async () => {
      vi.mocked(validateLoginCSRFToken).mockReturnValue(false);

      await POST(createRequest({ csrfToken: 'bad' }));

      expect(logSecurityEvent).toHaveBeenCalledWith('passkey_csrf_invalid', expect.objectContaining({
        email: undefined,
      }));
    });
  });

  describe('service errors', () => {
    it('returns 500 when generateAuthenticationOptions fails', async () => {
      vi.mocked(generateAuthenticationOptions).mockResolvedValue({
        ok: false,
        // @ts-expect-error - partial mock data
        error: { code: 'DB_ERROR', message: 'Database error' },
      });

      const response = await POST(createRequest({ csrfToken: 'valid' }));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to generate options');
      expect(loggers.auth.warn).toHaveBeenCalledWith('Passkey auth options failed', expect.objectContaining({
        error: 'DB_ERROR',
      }));
    });
  });

  describe('unexpected errors', () => {
    it('returns 500 on unexpected throw', async () => {
      vi.mocked(checkDistributedRateLimit).mockRejectedValueOnce(new Error('Unexpected'));

      const response = await POST(createRequest({ csrfToken: 'valid' }));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
      expect(loggers.auth.error).toHaveBeenCalledWith('Passkey auth options error', new Error('Unexpected'));
    });
  });
});
