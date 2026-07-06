import { describe, it, expect, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// NextResponse.rewrite() only exists in the edge runtime; the node/vitest env
// doesn't provide it. Polyfill it (before middleware is imported) so we can
// assert the middleware rewrites the discovery URL. In production the real
// edge-runtime rewrite records the target in the x-middleware-rewrite header.
if (typeof (NextResponse as { rewrite?: unknown }).rewrite !== 'function') {
  (NextResponse as unknown as { rewrite: (url: URL | string) => Response }).rewrite = (url) =>
    new Response(null, { status: 200, headers: { 'x-middleware-rewrite': String(url) } });
}

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
  it('rewrites /.well-known/oauth-authorization-server to the routable API handler with no session cookie', async () => {
    createSecureResponse.mockClear();
    const req = new NextRequest('https://pagespace.ai/.well-known/oauth-authorization-server');

    const response = await middleware(req);

    // Middleware REWRITES (not passes through) to the routable API handler —
    // this is what beats Next's prerendered/cached 404 for the .well-known
    // namespace, since next.config rewrites() run too late. NextResponse.rewrite
    // records the destination in x-middleware-rewrite.
    expect(response.headers.get('x-middleware-rewrite')).toContain(
      '/api/well-known/oauth-authorization-server',
    );
    // Public, pre-auth: the redirect-to-signin path (the original bug) is never reached.
    expect(response.status).not.toBe(307);
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
