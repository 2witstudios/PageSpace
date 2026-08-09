import { describe, it, expect, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// NextResponse.rewrite() only exists in the edge runtime. It is modelled in
// src/test/next-server-stub.ts (the `next/server` alias for tests), which is the
// single source of truth — this file used to carry its own local polyfill, and a
// second test asserting on rewrites promptly missed it and failed only in CI.

// Mock all runtime dependencies so middleware() can run without a real DB/session.
vi.mock('@/lib/logging/edge-logger', () => ({
  logSecurityEvent: vi.fn(),
  createEdgeLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
}));
vi.mock('@/middleware/monitoring', () => ({
  monitoringMiddleware: vi.fn((_req, handler: () => unknown) => handler()),
}));
const createSecureResponse = vi.fn(() => ({ response: { status: 200, headers: new Headers() } }));
const createSecureRewrite = vi.fn((destination: URL) => ({
  response: NextResponse.rewrite(destination),
  nonce: 'test-nonce',
}));
vi.mock('@/middleware/security-headers', () => ({
  createSecureResponse,
  createSecureRewrite,
  createSecureErrorResponse: vi.fn(),
  isHandoffBridgeRoute: vi.fn((pathname: string) => pathname === '/api/auth/google/callback' || pathname === '/api/auth/apple/callback'),
  isPublicPageRoute: vi.fn(() => false),
  isPublishedSiteHost: vi.fn(() => false),
  shouldDisableCOEP: vi.fn(() => false),
}));
// middleware.ts imports origin validation from its leaf module (never the
// Node-only '@/lib/auth' barrel), so that's what gets mocked. The bearer
// prefixes load from the real '@/lib/auth/token-prefixes' leaf: it's pure and
// edge-safe, and mocking it would just recreate the drift it exists to prevent.
vi.mock('@/lib/auth/origin-validation', () => ({
  validateOriginForMiddleware: vi.fn(() => ({ valid: true, skipped: true })),
  isOriginValidationBlocking: vi.fn(() => false),
}));
// No session cookie: this is the exact scenario the CLI login flow hits —
// discovery is always the first, unauthenticated request.
vi.mock('@/lib/auth/cookie-config', () => ({ getSessionFromCookies: vi.fn(() => null) }));

const { middleware } = await import('../../middleware');

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

  // Control case: a protected page still gets the signin treatment, so the
  // discovery rewrite above is demonstrably a carve-out and not the norm.
  // Deliberately NOT /dashboard — that path is now its own carve-out (the iOS
  // shell's entry point rewrites rather than redirects; see the case below).
  it('still redirects other unauthenticated non-API routes to sign-in (control case)', async () => {
    createSecureResponse.mockClear();
    const req = new NextRequest('https://pagespace.ai/settings/plan');

    const response = await middleware(req);

    expect(createSecureResponse).not.toHaveBeenCalled();
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/auth/signin');
  });

  it('rewrites — never redirects — unauthenticated /dashboard, so the iOS shell is not punted to Safari', async () => {
    createSecureResponse.mockClear();
    const req = new NextRequest('https://pagespace.ai/dashboard');

    const response = await middleware(req);

    expect(response.headers.get('x-middleware-rewrite')).toContain('/auth/signin');
    expect(response.status).not.toBe(307);
  });
});
