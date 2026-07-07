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
  createSecureErrorResponse: vi.fn((body: unknown, status: number) => new Response(JSON.stringify(body), { status })),
  isPublicPageRoute: vi.fn(() => false),
  isPublishedSiteHost: vi.fn(() => false),
  isSecureRequest: vi.fn(() => true),
  shouldDisableCOEP: vi.fn(() => false),
}));
vi.mock('@/lib/auth', () => ({
  validateOriginForMiddleware: vi.fn(() => ({ valid: true, skipped: true })),
  isOriginValidationBlocking: vi.fn(() => false),
  MCP_TOKEN_PREFIX: 'mcp_',
  SESSION_TOKEN_PREFIX: 'ps_sess_',
  OAUTH_ACCESS_TOKEN_PREFIX: 'ps_at_',
}));
// No session cookie: exactly the position of a brand-new visitor who has no
// account yet (signup) or is completing email verification from a link
// opened in a different browser/device than the one that signed up.
vi.mock('@/lib/auth/cookie-config', () => ({ getSessionFromCookies: vi.fn(() => null) }));

const { middleware } = await import('../../middleware');

// Regression coverage for a real bug: middleware.ts was relocated so it
// finally executes in production for the first time (previously it lived
// outside the src/ directory Next.js actually scans, so it silently never
// ran). Passwordless self-registration (WebAuthn passkey signup) and
// cross-device email verification both run with no session by definition —
// that's what they're creating/confirming — authenticating instead via a
// login-CSRF token, WebAuthn challenge, or an emailed one-time token. None
// of these were in the public-routes list, so newly-live middleware would
// 401 every anonymous signup/verification request before route.ts's own
// (correct) unauthenticated handling ever ran, breaking new-user signup
// entirely.
describe('middleware — signup/verification endpoints are public (pre-session by design)', () => {
  it.each([
    ['/api/auth/signup-passkey/options', 'POST'],
    ['/api/auth/signup-passkey', 'POST'],
    ['/api/auth/passkey/register/options', 'POST'],
    ['/api/auth/passkey/register', 'POST'],
    ['/api/auth/verify-email', 'GET'],
  ])('lets %s through with no session cookie instead of 401ing before the route runs', async (path, method) => {
    createSecureResponse.mockClear();
    const req = new NextRequest(`https://pagespace.ai${path}`, { method });

    const response = await middleware(req);

    expect(createSecureResponse).toHaveBeenCalled();
    expect(response.status).not.toBe(401);
  });

  it('control: /passkey/register/handoff always requires a session (401 with none), unlike /register itself', async () => {
    createSecureResponse.mockClear();
    const req = new NextRequest('https://pagespace.ai/api/auth/passkey/register/handoff', { method: 'POST' });

    const response = await middleware(req);

    expect(createSecureResponse).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });
});
