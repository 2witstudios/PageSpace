import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockValidateOriginForMiddleware = vi.hoisted(() => vi.fn());
const mockIsOriginValidationBlocking = vi.hoisted(() => vi.fn());
const mockGetSessionFromCookies = vi.hoisted(() => vi.fn());
const mockLogSecurityEvent = vi.hoisted(() => vi.fn());

vi.mock('@/middleware/monitoring', () => ({
  monitoringMiddleware: (_req: unknown, handler: () => unknown) => handler(),
}));

vi.mock('@/middleware/security-headers', () => ({
  createSecureResponse: () => ({ response: NextResponse.json({ ok: true }, { status: 200 }) }),
  createSecureErrorResponse: (body: unknown, status: number) => NextResponse.json(body, { status }),
  isPublicPageRoute: () => false,
  isPublishedSiteHost: () => false,
  isSecureRequest: () => true,
  shouldDisableCOEP: () => false,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  logSecurityEvent: mockLogSecurityEvent,
}));

vi.mock('@/lib/auth', () => ({
  validateOriginForMiddleware: mockValidateOriginForMiddleware,
  isOriginValidationBlocking: mockIsOriginValidationBlocking,
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  getSessionFromCookies: mockGetSessionFromCookies,
}));

vi.mock('@/lib/well-known/rewrites', () => ({
  WELL_KNOWN_REWRITES: [],
}));

import { middleware } from '../../middleware';

const buildRequest = (pathname: string, headers: Record<string, string> = {}) =>
  new NextRequest(new URL(`http://localhost${pathname}`), { headers });

describe('middleware — /api/public/forms carve-outs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionFromCookies.mockReturnValue(undefined);
  });

  it('skips the session-cookie check for a public form submit request with no session', async () => {
    mockValidateOriginForMiddleware.mockReturnValue({ valid: true, origin: null, skipped: true, reason: 'no origin' });
    mockIsOriginValidationBlocking.mockReturnValue(true);

    const request = buildRequest('/api/public/forms/pft_abc/submit');
    const response = await middleware(request);

    expect(response.status).not.toBe(401);
    // createSecureResponse is mocked to always return 200, so the status
    // check alone wouldn't catch the carve-out being removed — assert the
    // session-cookie lookup itself was never reached.
    expect(mockGetSessionFromCookies).not.toHaveBeenCalled();
  });

  it('never blocks on origin validation for this route, even in blocking mode with an invalid origin', async () => {
    mockValidateOriginForMiddleware.mockReturnValue({
      valid: false,
      origin: 'https://someone-elses-published-site.pagespace.site',
      skipped: false,
      reason: 'origin not in allowlist',
    });
    mockIsOriginValidationBlocking.mockReturnValue(true);

    const request = buildRequest('/api/public/forms/pft_abc/submit', {
      origin: 'https://someone-elses-published-site.pagespace.site',
    });
    const response = await middleware(request);

    expect(response.status).not.toBe(403);
    // Origin validation must never even run for this route — it's inapplicable
    // by design (valid callers have unbounded custom-domain origins).
    expect(mockValidateOriginForMiddleware).not.toHaveBeenCalled();
  });
});
