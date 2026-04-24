import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// Mock dependencies at system boundary
vi.mock('@pagespace/lib/auth/token-utils', () => ({
  hashToken: vi.fn().mockReturnValue('mocked-hash'),
}));
vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: {
    validateSession: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/permissions/enforced-context', () => ({
  EnforcedAuthContext: class EnforcedAuthContext {
    userId: string;
    userRole: string;
    constructor(claims: { userId: string; userRole: string }) {
      this.userId = claims.userId;
      this.userRole = claims.userRole;
    }
    static fromSession(claims: unknown): unknown {
      return { ctx: claims };
    }
  },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  logSecurityEvent: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      mcpTokens: {
        findFirst: vi.fn(),
      },
    },
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  mcpTokens: {},
}));

vi.mock('../csrf-validation', () => ({
  validateCSRF: vi.fn().mockResolvedValue(null),
}));

vi.mock('../origin-validation', () => ({
  validateOrigin: vi.fn().mockReturnValue(null),
}));

vi.mock('../cookie-config', () => ({
  getSessionFromCookies: vi.fn(),
}));

import { authenticateWithEnforcedContext, isEnforcedAuthError } from '../index';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { logSecurityEvent } from '@pagespace/lib/logging/logger-config';
import { validateCSRF } from '../csrf-validation';
import { getSessionFromCookies } from '../cookie-config';

const mockSessionClaims = {
  sessionId: 'test-session-id',
  userId: 'test-user-id',
  userRole: 'user' as const,
  tokenVersion: 0,
  adminRoleVersion: 0,
  type: 'user' as const,
  scopes: ['*'],
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
};

describe('authenticateWithEnforcedContext CSRF bypass regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sessionService.validateSession).mockResolvedValue(null);
    vi.mocked(validateCSRF).mockResolvedValue(null);
    vi.mocked(getSessionFromCookies).mockReturnValue(null);
  });

  it('rejects unknown Bearer token format even when session cookie is valid', async () => {
    // CRITICAL REGRESSION: An attacker sends `Authorization: Bearer garbage` to
    // bypass CSRF. The garbage token doesn't match mcp_ or ps_sess_, falls through
    // to cookie-based auth, and then CSRF is skipped because bearerToken is truthy.
    vi.mocked(getSessionFromCookies).mockReturnValue('ps_sess_valid');
    vi.mocked(sessionService.validateSession).mockResolvedValue(mockSessionClaims);

    const request = new Request('https://example.com/api/pages/123/permissions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer garbage_token',
        cookie: 'session=ps_sess_valid',
      },
    });

    const result = await authenticateWithEnforcedContext(request);

    expect(isEnforcedAuthError(result)).toBe(true);
    if (isEnforcedAuthError(result)) {
      expect(result.error.status).toBe(401);
    }
    expect(logSecurityEvent).toHaveBeenCalledWith('unauthorized', expect.objectContaining({
      reason: 'unknown_bearer_format',
    }));
  });

  it('rejects MCP tokens — EnforcedAuthContext requires full session claims', async () => {
    const request = new Request('https://example.com/api/pages/123/permissions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer mcp_some_token',
      },
    });

    const result = await authenticateWithEnforcedContext(request);

    expect(isEnforcedAuthError(result)).toBe(true);
    if (isEnforcedAuthError(result)) {
      expect(result.error.status).toBe(401);
      const body = await result.error.json();
      expect(body.error).toContain('MCP tokens are not permitted');
    }
  });

  it('authenticates valid ps_sess_ Bearer token without CSRF check', async () => {
    vi.mocked(sessionService.validateSession).mockResolvedValue(mockSessionClaims);

    const request = new Request('https://example.com/api/pages/123/permissions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ps_sess_valid_token',
      },
    });

    const result = await authenticateWithEnforcedContext(request);

    expect(isEnforcedAuthError(result)).toBe(false);
    expect(validateCSRF).not.toHaveBeenCalled();
  });

  it('returns 403 when cookie auth is used without CSRF token', async () => {
    vi.mocked(getSessionFromCookies).mockReturnValue('ps_sess_valid');
    vi.mocked(sessionService.validateSession).mockResolvedValue(mockSessionClaims);
    vi.mocked(validateCSRF).mockResolvedValue(
      NextResponse.json(
        { error: 'CSRF token required', code: 'CSRF_TOKEN_MISSING' },
        { status: 403 }
      )
    );

    const request = new Request('https://example.com/api/pages/123/permissions', {
      method: 'POST',
      headers: {
        cookie: 'session=ps_sess_valid',
      },
    });

    const result = await authenticateWithEnforcedContext(request);

    expect(isEnforcedAuthError(result)).toBe(true);
    if (isEnforcedAuthError(result)) {
      expect(result.error.status).toBe(403);
    }
  });

  it('succeeds when cookie auth is used with valid CSRF token', async () => {
    vi.mocked(getSessionFromCookies).mockReturnValue('ps_sess_valid');
    vi.mocked(sessionService.validateSession).mockResolvedValue(mockSessionClaims);
    vi.mocked(validateCSRF).mockResolvedValue(null);

    const request = new Request('https://example.com/api/pages/123/permissions', {
      method: 'POST',
      headers: {
        cookie: 'session=ps_sess_valid',
        'x-csrf-token': 'valid-csrf-token',
      },
    });

    const result = await authenticateWithEnforcedContext(request);

    expect(isEnforcedAuthError(result)).toBe(false);
    expect(validateCSRF).toHaveBeenCalledWith(request);
  });

  it('treats empty Bearer token as no token and falls through to cookie auth', async () => {
    // `Authorization: Bearer ` (trailing space, no token) — getBearerToken returns ""
    // which is falsy, so the request should fall through to cookie-based auth + CSRF.
    vi.mocked(getSessionFromCookies).mockReturnValue('ps_sess_valid');
    vi.mocked(sessionService.validateSession).mockResolvedValue(mockSessionClaims);
    vi.mocked(validateCSRF).mockResolvedValue(null);

    const request = new Request('https://example.com/api/pages/123/permissions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ',
        cookie: 'session=ps_sess_valid',
        'x-csrf-token': 'valid-csrf-token',
      },
    });

    const result = await authenticateWithEnforcedContext(request);

    expect(isEnforcedAuthError(result)).toBe(false);
    expect(validateCSRF).toHaveBeenCalledWith(request);
  });
});
