/**
 * The middleware's dev-preview host branch, and the matcher entry that
 * guarantees it RUNS. Both halves are load-bearing for host confinement:
 * a preview-host request that skipped the middleware (the `_next/*`
 * exclusion, or the prefetch `missing` clause) would reach App Router routes
 * on the preview apex — PageSpace's own chunks, image optimizer, or pages —
 * instead of the holder's proxied dev server.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, type NextFetchEvent } from 'next/server';

vi.mock('@/lib/logging/edge-logger', () => ({
  logSecurityEvent: vi.fn(),
  createEdgeLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
}));
vi.mock('@/middleware/monitoring', () => ({
  monitoringMiddleware: vi.fn((_req: unknown, next: () => Promise<Response>) => next()),
}));
vi.mock('@/middleware/security-headers', () => ({
  createSecureResponse: vi.fn(() => ({ response: new Response(null, { status: 200 }), nonce: 'n' })),
  createSecureRewrite: vi.fn(),
  createSecureErrorResponse: vi.fn(),
  APP_ROUTER_ROUTE_PATH: '/api/app-hosting/router',
  isHandoffBridgeRoute: vi.fn(() => false),
  routeOwnsItsOwnCsp: vi.fn(() => false),
  isPublicPageRoute: vi.fn(() => false),
  isPublishedSiteHost: vi.fn(() => false),
  shouldDisableCOEP: vi.fn(() => false),
}));
vi.mock('@/lib/auth/origin-validation', () => ({
  validateOriginForMiddleware: vi.fn(),
  isOriginValidationBlocking: vi.fn(),
}));
vi.mock('@/lib/auth/cookie-config', () => ({ getSessionFromCookies: vi.fn(() => undefined) }));

const { middleware, config } = await import('../middleware');

const APEX = 'pagespace-preview.app';
const HOST = `env-env1.preview.${APEX}`;

function request(pathname: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(`https://${HOST}${pathname}`), { headers: { host: HOST, ...headers } });
}

function rewriteTarget(response: Response | undefined): string | null {
  const target = response?.headers.get('x-middleware-rewrite');
  return target ? new URL(target).pathname : null;
}

describe('middleware matcher — preview hosts are never excluded', () => {
  it('carries a host-keyed entry with NO path exclusions and NO prefetch `missing` clause', () => {
    const hostEntry = config.matcher.find((entry) => 'has' in entry && (entry.has as Array<{ type: string }>).some((h) => h.type === 'host'));
    expect(hostEntry).toBeDefined();
    expect(hostEntry?.source).toBe('/:path*');
    expect('missing' in hostEntry!).toBe(false);
    const hostValue = (hostEntry!.has as Array<{ type: string; value: string }>).find((h) => h.type === 'host')!.value;
    expect(new RegExp(`^${hostValue}$`).test(HOST)).toBe(true);
    expect(new RegExp(`^${hostValue}$`).test('app.pagespace.ai')).toBe(false);
  });
});

describe('middleware — preview host branch', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.DEV_PREVIEW_ENABLED = 'true';
    process.env.DEV_PREVIEW_APEX = APEX;
    process.env.WEB_APP_URL = 'https://app.pagespace.ai';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('rewrites /_next/static/* on a preview host onto the forwarder — a proxied Next dev server serves its own /_next', async () => {
    const res = await middleware(request('/_next/static/chunks/main.js?v=1'), undefined as unknown as NextFetchEvent);
    expect(rewriteTarget(res)).toBe('/api/dev-preview/host/env/env1/_next/static/chunks/main.js');
    expect(new URL(res!.headers.get('x-middleware-rewrite')!).search).toBe('?v=1');
  });

  it('rewrites a prefetch on a preview host too — attacker-controlled <link rel=prefetch> never reaches app routes', async () => {
    for (const headers of [{ purpose: 'prefetch' }, { 'next-router-prefetch': '1' }] as Record<string, string>[]) {
      const res = await middleware(request('/dashboard', headers), undefined as unknown as NextFetchEvent);
      expect(rewriteTarget(res)).toBe('/api/dev-preview/host/env/env1/dashboard');
    }
  });

  it('rewrites the root and deep paths, and adds no security headers of its own', async () => {
    const res = await middleware(request('/'), undefined as unknown as NextFetchEvent);
    expect(rewriteTarget(res)).toBe('/api/dev-preview/host/env/env1/');
    expect(res?.headers.get('x-frame-options')).toBeNull();
    expect(res?.headers.get('content-security-policy')).toBeNull();
  });

  it('does nothing for a preview-shaped host when the feature is dark', async () => {
    delete process.env.DEV_PREVIEW_ENABLED;
    const res = await middleware(request('/_next/static/x.js'), undefined as unknown as NextFetchEvent);
    expect(rewriteTarget(res)).toBeNull();
  });
});
