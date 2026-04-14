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
  peekPasskeyRegisterHandoff: vi.fn(),
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
import {
  generateRegistrationOptions,
  validateCSRFToken,
  peekPasskeyRegisterHandoff,
} from '@pagespace/lib/auth';
import { loggers, auditRequest } from '@pagespace/lib/server';
import { checkDistributedRateLimit } from '@pagespace/lib/security';
import { authenticateSessionRequest, isAuthError, isSessionAuthResult, getClientIP } from '@/lib/auth';
import { NextResponse } from 'next/server';

const createRequest = (
  headers: Record<string, string> = {},
  body: Record<string, unknown> = {},
) =>
  new Request('http://localhost/api/auth/passkey/register/options', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': 'valid-csrf-token',
      ...headers,
    },
    body: JSON.stringify(body),
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
    vi.mocked(peekPasskeyRegisterHandoff).mockResolvedValue(null);
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
      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'security.suspicious.activity',
          details: expect.objectContaining({ reason: 'passkey_csrf_invalid', flow: 'register_options' }),
          riskScore: 0.6,
        })
      );
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

    it('does NOT skip CSRF when Authorization uses a non-Bearer scheme (e.g. Basic)', async () => {
      vi.mocked(validateCSRFToken).mockReturnValue(false);

      const response = await POST(createRequest({
        Authorization: 'Basic dXNlcjpwYXNz',
        'x-csrf-token': 'bad',
      }));
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
      expect(typeof body.options).toBe('object');
    });

    it('skips CSRF validation when auth result has no session (e.g. MCP token)', async () => {
      vi.mocked(isSessionAuthResult).mockReturnValue(false);
      vi.mocked(authenticateSessionRequest).mockResolvedValue({
        userId: 'user-1',
        role: 'user',
        tokenVersion: 0,
        adminRoleVersion: 0,
        tokenType: 'mcp',
        scopes: ['*'],
        tokenId: 'token-1',
        allowedDriveIds: [],
        isScoped: false,
      } as never);
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
      expect(typeof body.options).toBe('object');
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

  describe('desktop handoff-token branch', () => {
    it('accepts a valid handoff token without session auth or CSRF', async () => {
      vi.mocked(peekPasskeyRegisterHandoff).mockResolvedValue({
        userId: 'user-handoff',
        createdAt: Date.now(),
      });
      vi.mocked(generateRegistrationOptions).mockResolvedValue({
        ok: true,
        // @ts-expect-error - partial mock data
        data: { options: { challenge: 'h-chal' } },
      });

      const request = new Request('http://localhost/api/auth/passkey/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handoffToken: 'good-token' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.options).toEqual({ challenge: 'h-chal' });
      expect(peekPasskeyRegisterHandoff).toHaveBeenCalledWith('good-token');
      expect(authenticateSessionRequest).not.toHaveBeenCalled();
      expect(validateCSRFToken).not.toHaveBeenCalled();
      expect(generateRegistrationOptions).toHaveBeenCalledWith({ userId: 'user-handoff' });
    });

    it('returns 401 with HANDOFF_INVALID and audits when handoff token is invalid/expired', async () => {
      vi.mocked(peekPasskeyRegisterHandoff).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/passkey/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handoffToken: 'expired-token' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.code).toBe('HANDOFF_INVALID');
      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'security.suspicious.activity',
          details: expect.objectContaining({
            reason: 'passkey_handoff_invalid',
            flow: 'register_options',
          }),
        })
      );
      expect(generateRegistrationOptions).not.toHaveBeenCalled();
    });

    it('rate limits the handoff branch against the same per-user bucket', async () => {
      vi.mocked(peekPasskeyRegisterHandoff).mockResolvedValue({
        userId: 'user-rl',
        createdAt: Date.now(),
      });
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 300,
      });

      const request = new Request('http://localhost/api/auth/passkey/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handoffToken: 'good-token' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(429);
      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'passkey_register:user-rl',
        expect.any(Object)
      );
      expect(generateRegistrationOptions).not.toHaveBeenCalled();
    });

    it('treats a JSON "null" body as empty and falls through to the session path (not 500)', async () => {
      vi.mocked(generateRegistrationOptions).mockResolvedValue({
        ok: true,
        // @ts-expect-error - partial mock data
        data: { options: {} },
      });

      const request = new Request('http://localhost/api/auth/passkey/register/options', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': 'valid-csrf-token',
        },
        body: 'null',
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
      // Handoff never engaged; session auth path ran instead.
      expect(peekPasskeyRegisterHandoff).not.toHaveBeenCalled();
      expect(authenticateSessionRequest).toHaveBeenCalled();
    });

    it('returns 400 (not 500, not session fallthrough) when body is malformed JSON', async () => {
      const request = new Request('http://localhost/api/auth/passkey/register/options', {
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
      // Parse error surfaced before auth, so session auth never ran and no
      // handoff token was consulted — matches register/route.ts behavior.
      expect(authenticateSessionRequest).not.toHaveBeenCalled();
      expect(peekPasskeyRegisterHandoff).not.toHaveBeenCalled();
    });

    it('uses peek (not consume) so the verify step still finds the token', async () => {
      vi.mocked(peekPasskeyRegisterHandoff).mockResolvedValue({
        userId: 'user-1',
        createdAt: Date.now(),
      });
      vi.mocked(generateRegistrationOptions).mockResolvedValue({
        ok: true,
        // @ts-expect-error - partial mock data
        data: { options: {} },
      });

      const request = new Request('http://localhost/api/auth/passkey/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handoffToken: 'good-token' }),
      });

      await POST(request);

      expect(peekPasskeyRegisterHandoff).toHaveBeenCalledTimes(1);
    });
  });

  describe('unexpected errors', () => {
    it('returns 500 on unexpected throw', async () => {
      vi.mocked(authenticateSessionRequest).mockRejectedValueOnce(new Error('Unexpected'));

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
      expect(loggers.auth.error).toHaveBeenCalledWith('Passkey registration options error', new Error('Unexpected'));
    });
  });
});
