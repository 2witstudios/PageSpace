import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Mock all runtime dependencies so middleware() can run without a real DB/session.
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  logSecurityEvent: vi.fn(),
  logger: { child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@/middleware/monitoring', () => ({
  monitoringMiddleware: vi.fn((_req, handler: () => unknown) => handler()),
}));
const createSecureResponse = vi.fn(() => ({ response: { status: 200, headers: new Headers() } }));
vi.mock('@/middleware/security-headers', () => ({
  createSecureResponse,
  createSecureErrorResponse: vi.fn(),
  isPublicPageRoute: vi.fn(() => false),
  isPublishedSiteHost: vi.fn(() => false),
  shouldDisableCOEP: vi.fn(() => false),
}));
vi.mock('@/lib/auth', () => ({
  validateOriginForMiddleware: vi.fn(() => ({ valid: true, skipped: true })),
  isOriginValidationBlocking: vi.fn(() => false),
}));
// No session cookie: this is the exact scenario the CLI login flow hits —
// discovery is always the first, unauthenticated request.
vi.mock('@/lib/auth/cookie-config', () => ({ getSessionFromCookies: vi.fn(() => null) }));

const { middleware } = await import('../../../middleware');

describe('middleware — RFC 8414 discovery URL', () => {
  it('lets /.well-known/oauth-authorization-server through with no session cookie, as an API route', async () => {
    createSecureResponse.mockClear();
    const req = new NextRequest('https://pagespace.ai/.well-known/oauth-authorization-server');

    await middleware(req);

    // The redirect-to-signin path (the bug) is never reached: createSecureResponse
    // is called directly, and with isAPIRoute so JSON CSP applies, not page CSP.
    expect(createSecureResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ isAPIRoute: true }),
    );
  });

  it('still redirects other unauthenticated non-API routes to sign-in (control case)', async () => {
    createSecureResponse.mockClear();
    const req = new NextRequest('https://pagespace.ai/dashboard');

    const response = await middleware(req);

    expect(createSecureResponse).not.toHaveBeenCalled();
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/auth/signin');
  });
});
