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
}));
// No session cookie: exactly the CLI's position — it is a background process
// with no browser session, calling these endpoints directly over HTTP.
vi.mock('@/lib/auth/cookie-config', () => ({ getSessionFromCookies: vi.fn(() => null) }));

const { middleware } = await import('../../../middleware');

describe('middleware — OAuth grant endpoints are public by protocol design', () => {
  it.each([
    '/api/oauth/authorize',
    '/api/oauth/token',
    '/api/oauth/revoke',
    '/api/oauth/device_authorization',
  ])('lets POST %s through with no session cookie instead of 401ing before the route runs', async (path) => {
    createSecureResponse.mockClear();
    const req = new NextRequest(`https://pagespace.ai${path}`, { method: 'POST' });

    const response = await middleware(req);

    expect(createSecureResponse).toHaveBeenCalled();
    expect(response.status).not.toBe(401);
  });

  it.each([
    '/api/oauth/device_authorization/verify',
    '/api/oauth/device_authorization/decision',
  ])('control: %s is the browser /activate screen and still requires a session (401 with none)', async (path) => {
    createSecureResponse.mockClear();
    const req = new NextRequest(`https://pagespace.ai${path}`, { method: 'POST' });

    const response = await middleware(req);

    expect(createSecureResponse).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });
});
