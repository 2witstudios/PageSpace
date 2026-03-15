/**
 * Contract tests for POST /api/auth/passkey/register/options
 *
 * Tests the Request -> Response contract for generating WebAuthn registration options.
 * Requires session authentication and CSRF token.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('@pagespace/lib/auth', () => ({
  generateRegistrationOptions: vi.fn(),
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
  logSecurityEvent: vi.fn(),
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
import { generateRegistrationOptions, validateCSRFToken } from '@pagespace/lib/auth';
import { loggers, logSecurityEvent } from '@pagespace/lib/server';
import { checkDistributedRateLimit } from '@pagespace/lib/security';
import { authenticateSessionRequest, isAuthError, isSessionAuthResult, getClientIP } from '@/lib/auth';
import { NextResponse } from 'next/server';

const createRequest = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/auth/passkey/register/options', {
    method: 'POST',
    headers: {
      'x-csrf-token': 'valid-csrf-token',
      ...headers,
    },
  });

describe('POST /api/auth/passkey/register/options', () => {
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

  describe('successful options generation', () => {
    it('returns 200 with registration options', async () => {
      const mockOptions = { challenge: 'xyz', rp: { name: 'PageSpace' } };
      vi.mocked(generateRegistrationOptions).mockResolvedValue({
        ok: true,
        // @ts-expect-error - partial mock data
        data: { options: mockOptions },
      });

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.options).toEqual(mockOptions);
      expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    });

    it('calls generateRegistrationOptions with userId', async () => {
      vi.mocked(generateRegistrationOptions).mockResolvedValue({
        ok: true,
        // @ts-expect-error - partial mock data
        data: { options: {} },
      });

      await POST(createRequest());

      expect(generateRegistrationOptions).toHaveBeenCalledWith({ userId: 'user-1' });
    });

    it('logs options generation', async () => {
      vi.mocked(generateRegistrationOptions).mockResolvedValue({
        ok: true,
        // @ts-expect-error - partial mock data
        data: { options: {} },
      });

      await POST(createRequest());

      expect(loggers.auth.info).toHaveBeenCalledWith('Passkey registration options generated', expect.objectContaining({
        userId: 'user-1',
      }));
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

      const response = await POST(createRequest({ 'x-csrf-token': 'bad' }));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Invalid CSRF token');
      expect(logSecurityEvent).toHaveBeenCalledWith('passkey_csrf_invalid', expect.objectContaining({
        flow: 'register_options',
      }));
    });

    it('returns 403 when CSRF token is missing', async () => {
      vi.mocked(validateCSRFToken).mockReturnValue(false);

      const request = new Request('http://localhost/api/auth/passkey/register/options', {
        method: 'POST',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Invalid CSRF token');
    });

    it('skips CSRF validation for Bearer token auth', async () => {
      vi.mocked(isSessionAuthResult).mockReturnValue(true);
      vi.mocked(validateCSRFToken).mockReturnValue(false);
      vi.mocked(generateRegistrationOptions).mockResolvedValue({
        ok: true,
        // @ts-expect-error - partial mock data
        data: { options: {} },
      });

      const response = await POST(createRequest({ 'Authorization': 'Bearer ps_sess_token' }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.options).toBeDefined();
    });

    it('skips CSRF validation when sessionId is null', async () => {
      vi.mocked(isSessionAuthResult).mockReturnValue(false);
      vi.mocked(generateRegistrationOptions).mockResolvedValue({
        ok: true,
        // @ts-expect-error - partial mock data
        data: { options: {} },
      });

      const request = new Request('http://localhost/api/auth/passkey/register/options', {
        method: 'POST',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.options).toBeDefined();
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
      expect(logSecurityEvent).toHaveBeenCalledWith('passkey_rate_limit_register', expect.objectContaining({
        userId: 'user-1',
        retryAfter: 300,
      }));
    });
  });

  describe('service errors', () => {
    const errorCases = [
      { code: 'USER_NOT_FOUND', status: 404, message: 'User not found' },
      { code: 'USER_SUSPENDED', status: 403, message: 'Account suspended' },
      { code: 'MAX_PASSKEYS_REACHED', status: 400, message: 'Maximum passkeys limit reached' },
      { code: 'VALIDATION_FAILED', status: 400, message: 'Validation failed' },
    ];

    errorCases.forEach(({ code, status, message }) => {
      it(`returns ${status} for ${code}`, async () => {
        vi.mocked(generateRegistrationOptions).mockResolvedValue({
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
      vi.mocked(generateRegistrationOptions).mockResolvedValue({
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

    it('logs service failures', async () => {
      vi.mocked(generateRegistrationOptions).mockResolvedValue({
        ok: false,
        // @ts-expect-error - partial mock data
        error: { code: 'DB_ERROR', message: 'Database error' },
      });

      await POST(createRequest());

      expect(loggers.auth.warn).toHaveBeenCalledWith('Passkey registration options failed', expect.objectContaining({
        error: 'DB_ERROR',
      }));
    });
  });

  describe('unexpected errors', () => {
    it('returns 500 on unexpected throw', async () => {
      vi.mocked(authenticateSessionRequest).mockRejectedValue(new Error('Unexpected'));

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
      expect(loggers.auth.error).toHaveBeenCalledWith('Passkey registration options error', expect.any(Error));
    });
  });
});
