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
// No session cookie: exactly a third-party webhook caller's position — Stripe,
// Google, and Zoom are background services with no browser session, calling
// these endpoints directly over HTTP and authenticating via their own
// signature/HMAC check inside each route's own handler instead.
vi.mock('@/lib/auth/cookie-config', () => ({ getSessionFromCookies: vi.fn(() => null) }));

const { middleware } = await import('../../middleware');

// Regression coverage for a real bug: middleware.ts was relocated so it
// finally executes in production for the first time (previously it lived
// outside the src/ directory Next.js actually scans, so it silently never
// ran). That means every webhook route's own signature/HMAC verification —
// previously reached unobstructed — now has to first clear this middleware's
// session-cookie gate. Only /api/integrations/zoom/webhook was allowlisted;
// /api/stripe/webhook and /api/integrations/google-calendar/webhook were
// missing, which would have 401'd Stripe billing events and Google Calendar
// sync notifications before their own signature checks ever ran.
describe('middleware — third-party webhooks are public (own signature/HMAC auth, no session)', () => {
  it.each([
    '/api/stripe/webhook',
    '/api/integrations/google-calendar/webhook',
    '/api/integrations/zoom/webhook',
  ])('lets POST %s through with no session cookie instead of 401ing before the route runs', async (path) => {
    createSecureResponse.mockClear();
    const req = new NextRequest(`https://pagespace.ai${path}`, { method: 'POST' });

    const response = await middleware(req);

    expect(createSecureResponse).toHaveBeenCalled();
    expect(response.status).not.toBe(401);
  });

  it('control: a similar but non-allowlisted integrations path still requires a session (401 with none)', async () => {
    createSecureResponse.mockClear();
    const req = new NextRequest('https://pagespace.ai/api/integrations/zoom/settings', { method: 'POST' });

    const response = await middleware(req);

    expect(createSecureResponse).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });
});
