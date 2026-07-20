import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Mock all runtime dependencies so middleware() can run without a real DB/session.
vi.mock('@/lib/logging/edge-logger', () => ({
  logSecurityEvent: vi.fn(),
  createEdgeLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
}));
vi.mock('@/middleware/monitoring', () => ({
  monitoringMiddleware: vi.fn((_req, handler: () => unknown) => handler()),
}));
const createSecureResponse = vi.fn(() => ({ response: { status: 200, headers: new Headers() } }));
vi.mock('@/middleware/security-headers', () => ({
  createSecureResponse,
  createSecureErrorResponse: vi.fn((body: unknown, status: number) => new Response(JSON.stringify(body), { status })),
  isHandoffBridgeRoute: vi.fn((pathname: string) => pathname === '/api/auth/google/callback' || pathname === '/api/auth/apple/callback'),
  isPublicPageRoute: vi.fn(() => false),
  isPublishedSiteHost: vi.fn(() => false),
  isSecureRequest: vi.fn(() => true),
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
// No session cookie: exactly the position of an anonymous visitor (Apple sign-in,
// email-link click-throughs, public asset requests) or a caller authenticating
// via its own out-of-band credential (internal service secret, provisioning poll).
vi.mock('@/lib/auth/cookie-config', () => ({ getSessionFromCookies: vi.fn(() => null) }));

const { middleware } = await import('../../middleware');

// Regression coverage for a real bug: middleware.ts was relocated so it finally
// executes in production for the first time (previously it lived outside the
// src/ directory Next.js actually scans, so it silently never ran). Cross-
// referencing this codebase's own public-route documentation
// (apps/web/src/app/api/__tests__/security-audit-coverage.test.ts) against
// route.ts auth code surfaced several more pre-session/public endpoints that
// were missing from the allowlist and would now 401 before their own
// (correct) auth logic ever ran.
describe('middleware — pre-session auth + public asset/internal endpoints', () => {
  it.each([
    ['/api/auth/apple/signin', 'POST'],
    ['/api/auth/apple/callback', 'POST'],
    ['/api/auth/step-up/magic-link/verify', 'GET'],
    ['/api/auth/logout', 'POST'],
    ['/api/internal/contact', 'POST'],
    ['/api/internal/monitoring/ingest', 'POST'],
    ['/api/notifications/unsubscribe/abc123', 'GET'],
    ['/api/ai/models', 'GET'],
    ['/api/compiled-css', 'GET'],
    ['/api/avatar/user123/photo.png', 'GET'],
    ['/api/provisioning-status/my-tenant', 'GET'],
    ['/api/contact', 'POST'],
  ])('lets %s through with no session cookie instead of 401ing before the route runs', async (path, method) => {
    createSecureResponse.mockClear();
    const req = new NextRequest(`https://pagespace.ai${path}`, { method });

    const response = await middleware(req);

    expect(createSecureResponse).toHaveBeenCalled();
    expect(response.status).not.toBe(401);
  });

  it.each([
    ['/api/notifications/read-all', 'control: a similar but non-unsubscribe notifications path still requires a session'],
    ['/api/account/avatar', 'control: the authenticated account-avatar-upload route (distinct from the public /api/avatar/ asset path) still requires a session'],
  ])('%s: 401s with no session cookie', async (path) => {
    createSecureResponse.mockClear();
    const req = new NextRequest(`https://pagespace.ai${path}`, { method: 'POST' });

    const response = await middleware(req);

    expect(createSecureResponse).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });
});
