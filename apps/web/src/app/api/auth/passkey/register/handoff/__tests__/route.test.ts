/**
 * Contract tests for POST /api/auth/passkey/register/handoff
 *
 * Authenticated endpoint the Electron renderer calls to mint a one-time
 * handoff token that authorises an external-browser passkey registration
 * ceremony. Required because Electron's Chromium cannot drive platform
 * authenticators on macOS without entitlements we don't ship.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/auth/passkey-register-handoff', () => ({
    createPasskeyRegisterHandoff: vi.fn(),
}));
vi.mock('@pagespace/lib/auth/csrf-utils', () => ({
    validateCSRFToken: vi.fn(),
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

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
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
import { createPasskeyRegisterHandoff } from '@pagespace/lib/auth/passkey-register-handoff'
import { validateCSRFToken } from '@pagespace/lib/auth/csrf-utils';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import {
  authenticateSessionRequest,
  isAuthError,
  isSessionAuthResult,
} from '@/lib/auth';
import { NextResponse } from 'next/server';

const createRequest = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/auth/passkey/register/handoff', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': 'valid-csrf-token',
      ...headers,
    },
    body: JSON.stringify({}),
  });

describe('POST /api/auth/passkey/register/handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();

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
    vi.mocked(createPasskeyRegisterHandoff).mockResolvedValue('handoff-token-abc');
  });

  describe('successful mint', () => {
    it('returns 200 with handoffToken and 300s expiresIn', async () => {
      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.handoffToken).toBe('handoff-token-abc');
      expect(body.expiresIn).toBe(300);
      expect(response.headers.get('Cache-Control')).toBe(
        'no-store, no-cache, must-revalidate'
      );
    });

    it('mints the handoff against the authenticated userId', async () => {
      await POST(createRequest());

      expect(createPasskeyRegisterHandoff).toHaveBeenCalledWith({ userId: 'user-1' });
    });

    it('audits token creation', async () => {
      await POST(createRequest());

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'auth.token.created',
          userId: 'user-1',
          details: expect.objectContaining({ tokenType: 'passkey_register_handoff' }),
        })
      );
    });
  });

  describe('authentication errors', () => {
    it('returns auth error when not authenticated', async () => {
      const authErrorResponse = NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateSessionRequest).mockResolvedValue({ error: authErrorResponse });

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Authentication required');
      expect(createPasskeyRegisterHandoff).not.toHaveBeenCalled();
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
          details: expect.objectContaining({
            reason: 'passkey_csrf_invalid',
            flow: 'register_handoff',
          }),
        })
      );
      expect(createPasskeyRegisterHandoff).not.toHaveBeenCalled();
    });

    it('returns 403 when CSRF header is missing', async () => {
      vi.mocked(validateCSRFToken).mockReturnValue(false);

      const request = new Request('http://localhost/api/auth/passkey/register/handoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const response = await POST(request);
      expect(response.status).toBe(403);
    });

    it('does NOT skip CSRF when Authorization uses a non-Bearer scheme (e.g. Basic)', async () => {
      vi.mocked(validateCSRFToken).mockReturnValue(false);

      const response = await POST(
        createRequest({
          Authorization: 'Basic dXNlcjpwYXNz',
          'x-csrf-token': 'bad',
        })
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Invalid CSRF token');
      expect(createPasskeyRegisterHandoff).not.toHaveBeenCalled();
    });

    it('skips CSRF validation for Bearer token auth', async () => {
      vi.mocked(validateCSRFToken).mockReturnValue(false);

      const response = await POST(
        createRequest({ Authorization: 'Bearer ps_sess_token' })
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.handoffToken).toBe('handoff-token-abc');
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when rate limited and does not mint', async () => {
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
        })
      );
      expect(createPasskeyRegisterHandoff).not.toHaveBeenCalled();
    });

    it('uses the same per-user passkey_register bucket as the register routes', async () => {
      await POST(createRequest());

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'passkey_register:user-1',
        expect.any(Object)
      );
    });

    it('five back-to-back mint calls succeed and the sixth returns 429 — mint is the real rate gate', async () => {
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 4 })
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 3 })
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 2 })
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 1 })
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 0 })
        .mockResolvedValueOnce({ allowed: false, attemptsRemaining: 0, retryAfter: 300 });

      const r1 = await POST(createRequest());
      const r2 = await POST(createRequest());
      const r3 = await POST(createRequest());
      const r4 = await POST(createRequest());
      const r5 = await POST(createRequest());
      const r6 = await POST(createRequest());

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);
      expect(r4.status).toBe(200);
      expect(r5.status).toBe(200);
      expect(r6.status).toBe(429);
      expect(createPasskeyRegisterHandoff).toHaveBeenCalledTimes(5);
    });
  });

  describe('unexpected errors', () => {
    it('returns 500 when createPasskeyRegisterHandoff throws', async () => {
      vi.mocked(createPasskeyRegisterHandoff).mockRejectedValueOnce(
        new Error('Redis unavailable')
      );

      const response = await POST(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Passkey register handoff error',
        expect.any(Error)
      );
    });
  });
});
