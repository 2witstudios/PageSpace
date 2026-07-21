import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockValidateOriginForMiddleware = vi.hoisted(() => vi.fn());
const mockIsOriginValidationBlocking = vi.hoisted(() => vi.fn());
const mockGetSessionFromCookies = vi.hoisted(() => vi.fn());
const mockLogSecurityEvent = vi.hoisted(() => vi.fn());
const mockCreateSecureResponse = vi.hoisted(() => vi.fn());

vi.mock('@/middleware/monitoring', () => ({
  monitoringMiddleware: (_req: unknown, handler: () => unknown) => handler(),
}));

const MOCK_API_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-PageSpace-API-Version',
  'Access-Control-Expose-Headers': 'X-PageSpace-API-Version, Retry-After',
};

vi.mock('@/middleware/security-headers', () => ({
  createSecureResponse: mockCreateSecureResponse,
  // Kept faithful to the real implementation's rewrite: the whole point of the
  // /dashboard branch is that Next emits an x-middleware-rewrite header instead
  // of a 307, so a stub that dropped it would assert nothing.
  createSecureRewrite: (destination: URL) => ({
    response: NextResponse.rewrite(destination),
    nonce: 'test-nonce',
  }),
  createSecureErrorResponse: (body: unknown, status: number) => NextResponse.json(body, { status }),
  // Real predicate logic — middleware passes its result as `skipCSP` so the
  // handoff-bridge OAuth callbacks don't get a middleware CSP layered on top of
  // their own (see the isHandoffBridgeRoute describe block below).
  isHandoffBridgeRoute: (pathname: string) =>
    pathname === '/api/auth/google/callback' || pathname === '/api/auth/apple/callback',
  isPublicPageRoute: () => false,
  isPublishedSiteHost: () => false,
  isSecureRequest: () => true,
  shouldDisableCOEP: () => false,
  applyApiCorsHeaders: (response: NextResponse) => {
    for (const [key, value] of Object.entries(MOCK_API_CORS_HEADERS)) {
      response.headers.set(key, value);
    }
    return response;
  },
}));

vi.mock('@/lib/logging/edge-logger', () => ({
  logSecurityEvent: mockLogSecurityEvent,
  createEdgeLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
}));

// middleware.ts imports origin validation from its leaf module (never the
// Node-only '@/lib/auth' barrel), so that's what gets mocked. The bearer
// prefixes are NOT mocked: middleware.ts builds its prefix checks from the
// real '@/lib/auth/token-prefixes' leaf at module-load time (`Bearer
// ${MCP_TOKEN_PREFIX}` etc.) — it's pure and edge-safe, and a mocked-away
// value would silently break every prefix check this file's tests exercise
// below, the same way a hand-duplicated copy already drifted out of sync once
// (see middleware.ts's import site comment).
vi.mock('@/lib/auth/origin-validation', () => ({
  validateOriginForMiddleware: mockValidateOriginForMiddleware,
  isOriginValidationBlocking: mockIsOriginValidationBlocking,
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  getSessionFromCookies: mockGetSessionFromCookies,
}));

vi.mock('@/lib/well-known/rewrites', () => ({
  WELL_KNOWN_REWRITES: [],
}));

import { middleware } from '../middleware';

// clearAllMocks() (used in every beforeEach) resets calls but keeps this
// implementation, so a single default set here survives the whole suite.
mockCreateSecureResponse.mockImplementation(() => ({
  response: NextResponse.json({ ok: true }, { status: 200 }),
}));

const buildRequest = (pathname: string, headers: Record<string, string> = {}, method = 'GET') =>
  new NextRequest(new URL(`http://localhost${pathname}`), { headers, method });

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

// Regression coverage for a real bug: middleware.ts used to hand-duplicate two
// of the three bearer prefixes `@/lib/auth` actually authenticates (mcp_,
// ps_sess_), silently missing ps_at_ (OAuth access tokens, `pagespace login`).
// Any ps_at_-authenticated request to a non-allowlisted API route would fall
// through to the session-cookie check and get a false 401 — undetected until
// now because this middleware was never actually registered/executed in any
// deployed build (wrong Next.js discovery path). All three prefixes must
// bypass the session-cookie gate identically.
describe('middleware — bearer-token prefix carve-out (all three token types)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionFromCookies.mockReturnValue(undefined);
    mockValidateOriginForMiddleware.mockReturnValue({ valid: true, origin: null, skipped: true, reason: 'no origin' });
    mockIsOriginValidationBlocking.mockReturnValue(true);
  });

  it.each([
    ['mcp', 'Bearer mcp_abc123'],
    ['session', 'Bearer ps_sess_abc123'],
    ['oauth', 'Bearer ps_at_abc123'],
  ])('bypasses the session-cookie check for a %s bearer token on a non-allowlisted API route', async (_kind, authorization) => {
    // /api/pages, unlike /api/drives, is NOT in the public allowlist — this
    // isolates the bearer-prefix check itself rather than accidentally passing
    // via that separate carve-out regardless of the auth header.
    const request = buildRequest('/api/pages/xyz', { authorization });
    const response = await middleware(request);

    expect(response.status).not.toBe(401);
    expect(mockGetSessionFromCookies).not.toHaveBeenCalled();
  });

  it('still falls through to the session-cookie check (and 401s with none) for an unrecognized bearer prefix', async () => {
    const request = buildRequest('/api/pages/xyz', { authorization: 'Bearer not_a_real_prefix_xyz' });
    const response = await middleware(request);

    expect(mockGetSessionFromCookies).toHaveBeenCalled();
    expect(response.status).toBe(401);
  });
});

// CORS for the Bearer-authenticated API surface (@pagespace/sdk calling
// pagespace.ai directly from a browser — see the browser-compat plan). A
// browser blocks a cross-origin response with no Access-Control-Allow-Origin
// regardless of whether the server-side auth itself would have succeeded, so
// these headers must be present on every Bearer-authed response and on the
// preflight that precedes it.
describe('middleware — CORS for Bearer-authenticated API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionFromCookies.mockReturnValue(undefined);
    mockIsOriginValidationBlocking.mockReturnValue(true);
  });

  it('attaches CORS headers and skips origin validation for a Bearer-prefixed request to /api/*', async () => {
    // An origin that origin-validation would normally reject in block mode —
    // proves this path never even reaches that check.
    mockValidateOriginForMiddleware.mockReturnValue({
      valid: false,
      origin: 'https://some-external-spa.example',
      skipped: false,
      reason: 'origin not in allowlist',
    });

    const request = buildRequest('/api/pages/xyz', {
      authorization: 'Bearer ps_at_abc123',
      origin: 'https://some-external-spa.example',
    });
    const response = await middleware(request);

    expect(response.status).not.toBe(403);
    expect(mockValidateOriginForMiddleware).not.toHaveBeenCalled();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-PageSpace-API-Version');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Retry-After');
  });

  it('leaves session-cookie traffic to the same path fully subject to origin validation, unaffected', async () => {
    mockValidateOriginForMiddleware.mockReturnValue({
      valid: false,
      origin: 'https://some-external-spa.example',
      skipped: false,
      reason: 'origin not in allowlist',
    });

    const request = buildRequest('/api/pages/xyz', { origin: 'https://some-external-spa.example' });
    const response = await middleware(request);

    expect(mockValidateOriginForMiddleware).toHaveBeenCalledWith(request);
    expect(response.status).toBe(403);
  });

  it('answers a bare OPTIONS preflight to /api/* with a 204 and CORS headers, with no auth check at all', async () => {
    const request = buildRequest('/api/pages/xyz', {}, 'OPTIONS');
    const response = await middleware(request);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(mockValidateOriginForMiddleware).not.toHaveBeenCalled();
    expect(mockGetSessionFromCookies).not.toHaveBeenCalled();
  });
});

// The iOS shell remote-loads https://pagespace.ai/dashboard. Capacitor's
// WKNavigationDelegate cancels any top-level navigation whose URL does not start
// with that exact string and opens it in system Safari instead, leaving the
// WebView with no document — the black screen on every cold launch with no
// session cookie. A *redirect* to /auth/signin trips that. A *rewrite* is not a
// navigation at all, so the signin page renders in place and the shell survives.
// This is scoped to /dashboard (the shell's only entry point); everywhere else
// must keep the honest redirect and its correct URL bar.
describe('middleware — unauthenticated /dashboard rewrites instead of redirecting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionFromCookies.mockReturnValue(undefined);
    mockValidateOriginForMiddleware.mockReturnValue({ valid: true, origin: null, skipped: true, reason: 'no origin' });
    mockIsOriginValidationBlocking.mockReturnValue(true);
  });

  const rewriteTarget = (response: NextResponse): string | null =>
    response.headers.get('x-middleware-rewrite');

  it.each([['/dashboard'], ['/dashboard/drv_abc/pg_xyz'], ['/dashboard/drv_abc?tab=chat']])(
    'rewrites %s to a BARE /auth/signin',
    async (pathname) => {
      const response = await middleware(buildRequest(pathname));

      const target = rewriteTarget(response);
      expect(target).not.toBeNull();
      const url = new URL(target as string);
      expect(url.pathname).toBe('/auth/signin');

      // No next= on the rewrite, deliberately. A rewrite leaves the browser URL alone, so
      // the browser is still ON the deep link and the client reads it off the path. Putting
      // it here too would have the server render a value the client cannot see — and it
      // reaches the DOM (the signup link's href), i.e. a hydration mismatch.
      expect(url.searchParams.get('next')).toBeNull();

      // A rewrite is emphatically not a redirect — a 307 here is the bug.
      expect(response.status).not.toBe(307);
      expect(response.headers.get('location')).toBeNull();
    },
  );

  // The last hydration hole: a `next=` on a /dashboard URL is visible to the client (which
  // reads the browser URL) but not to the server (which renders the bare rewrite
  // destination), and nextPath reaches the DOM. Nothing in the app produces such a URL, but
  // a crafted one must not be able to desync the two renders — so it is redirected away
  // first. Safe under the iOS shell: still under /dashboard, so it passes the prefix test.
  it('redirects a /dashboard URL carrying a crafted next= to the same URL without it, rather than rewriting', async () => {
    const response = await middleware(buildRequest('/dashboard/drv_abc?tab=chat&next=%2Fdashboard%2Fother'));

    expect(response.status).toBe(307);
    expect(rewriteTarget(response)).toBeNull();

    const location = new URL(response.headers.get('location') as string);
    // Redirected back to /dashboard (NOT to signin) — so it still prefix-matches
    // server.url and the iOS shell will not punt it to Safari. And no `next` is left, so
    // the follow-up request rewrites cleanly and cannot loop.
    expect(location.pathname).toBe('/dashboard/drv_abc');
    expect(location.searchParams.get('next')).toBeNull();
    expect(location.searchParams.get('tab')).toBe('chat');
  });

  it('still REDIRECTS an unauthenticated page request outside /dashboard, with next= preserved', async () => {
    const response = await middleware(buildRequest('/activate?user_code=ABCD-EFGH'));

    expect(response.status).toBe(307);
    expect(rewriteTarget(response)).toBeNull();

    const location = new URL(response.headers.get('location') as string);
    expect(location.pathname).toBe('/auth/signin');
    expect(location.searchParams.get('next')).toBe('/activate?user_code=ABCD-EFGH');
  });

  // The redirect path is the only one that carries next=, so it is where the
  // reconstruction rules have to be pinned down.
  describe('next= on the redirect', () => {
    const location = (response: NextResponse): URL =>
      new URL(response.headers.get('location') as string);

    // Drives the isSafeNextPath guard in buildSigninUrl to FALSE. Without a
    // non-allowlisted path in this suite the guard is dead weight: every other case
    // reconstructs a candidate under /dashboard or /activate, which always passes, so
    // deleting the check entirely would not fail a single other test here.
    it('omits next= entirely for a page outside SIGNIN_NEXT_ALLOWED_PREFIXES', async () => {
      const response = await middleware(buildRequest('/settings/plan'));

      expect(response.status).toBe(307);
      expect(location(response).searchParams.get('next')).toBeNull();
    });

    // next= is always the path actually requested. A caller-supplied one is dropped rather
    // than honoured — otherwise a query param could override the real destination.
    it('ignores a caller-supplied next= and preserves the actually-requested path', async () => {
      const response = await middleware(buildRequest('/activate?next=%2Fdashboard%2Felsewhere'));

      expect(location(response).searchParams.get('next')).toBe('/activate');
    });

    it('drops an off-origin next= instead of passing it through', async () => {
      const response = await middleware(buildRequest('/activate?next=https%3A%2F%2Fevil.example%2Fx'));

      // Falls back to the requested path; the attacker-supplied value never survives.
      expect(location(response).searchParams.get('next')).toBe('/activate');
    });

    // A soft nav that hits an expired session carries Next's RSC cache-buster. Landing the
    // user back on `/activate?_rsc=abc` after signin would be stale and meaningless.
    it("strips Next's _rsc cache-buster from the preserved deep link", async () => {
      const response = await middleware(buildRequest('/activate?user_code=ABCD&_rsc=1a2b3c'));

      expect(location(response).searchParams.get('next')).toBe('/activate?user_code=ABCD');
    });
  });

  it('does not rewrite for an unauthenticated API request under /api — that still 401s', async () => {
    const response = await middleware(buildRequest('/api/pages/xyz'));

    expect(response.status).toBe(401);
    expect(rewriteTarget(response)).toBeNull();
  });
});

// The Electron desktop shell navigates with COOKIES, not its Bearer token —
// the renderer's real credential lives in the main process and is attached per
// API call by authFetch. When the session cookie is missing or stale, the
// middleware's page-navigation gate used to bounce the shell to the signin
// form ("randomly logged out") even though the Bearer was perfectly valid.
// For the Electron shell the gate must let the page load and let the client
// recover via its Bearer; this relaxes only the navigation UX gate, never an
// auth boundary — every API route still validates normally.
describe('middleware — Electron shell page navigations are never bounced to signin', () => {
  const ELECTRON_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PageSpace/1.0.23 Chrome/130.0.6723.137 Electron/33.3.1 Safari/537.36';
  const BROWSER_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.137 Safari/537.36';

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionFromCookies.mockReturnValue(undefined);
    mockValidateOriginForMiddleware.mockReturnValue({ valid: true, origin: null, skipped: true, reason: 'no origin' });
    mockIsOriginValidationBlocking.mockReturnValue(true);
  });

  it.each([['/dashboard'], ['/dashboard/drv_abc/pg_xyz']])(
    'lets the Electron shell load %s with no session cookie — no redirect, no signin rewrite',
    async (pathname) => {
      const response = await middleware(buildRequest(pathname, { 'user-agent': ELECTRON_UA }));

      // Neither bounce mechanism may fire: not the 307 redirect, not the
      // /dashboard signin rewrite (which renders the signin form in place —
      // the exact "logged out" the desktop user reports).
      expect(response.status).not.toBe(307);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    },
  );

  it('lets the Electron shell load a non-dashboard page with no session cookie', async () => {
    const response = await middleware(buildRequest('/activate?user_code=ABCD', { 'user-agent': ELECTRON_UA }));

    expect(response.status).not.toBe(307);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('still redirects a BROWSER page navigation with no session cookie to signin, exactly as before', async () => {
    const response = await middleware(buildRequest('/activate?user_code=ABCD-EFGH', { 'user-agent': BROWSER_UA }));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location') as string);
    expect(location.pathname).toBe('/auth/signin');
    expect(location.searchParams.get('next')).toBe('/activate?user_code=ABCD-EFGH');
  });

  it('leaves the iOS/Capacitor /dashboard signin REWRITE untouched for non-Electron UAs', async () => {
    // The iOS shell is a WKWebView with no Electron/ token — it must keep the
    // rewrite-in-place behavior (redirecting it black-screens the shell).
    const response = await middleware(buildRequest('/dashboard/drv_abc', { 'user-agent': BROWSER_UA }));

    const target = response.headers.get('x-middleware-rewrite');
    expect(target).not.toBeNull();
    expect(new URL(target as string).pathname).toBe('/auth/signin');
    expect(response.status).not.toBe(307);
  });

  it.each([
    ['Electron shell', 'Mozilla/5.0 PageSpace/1.0.23 Electron/33.3.1 Safari/537.36'],
    ['browser', 'Mozilla/5.0 Chrome/130.0.6723.137 Safari/537.36'],
  ])('keeps API routes fully gated for a %s request with no credentials — still 401', async (_kind, ua) => {
    const response = await middleware(buildRequest('/api/ai/chat/active-streams', { 'user-agent': ua }));

    expect(response.status).toBe(401);
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('does NOT log a security "unauthorized" event for an accepted Electron shell page navigation', async () => {
    // The navigation is deliberately accepted — logging it as unauthorized
    // would flood the security drain on every client-side route change of a
    // cookie-less desktop session and obscure real failures.
    await middleware(buildRequest('/dashboard/drv_abc', { 'user-agent': ELECTRON_UA }));

    expect(mockLogSecurityEvent).not.toHaveBeenCalled();
  });

  it('still logs the unauthorized event for an Electron API request with no credentials', async () => {
    await middleware(buildRequest('/api/ai/chat/active-streams', { 'user-agent': ELECTRON_UA }));

    expect(mockLogSecurityEvent).toHaveBeenCalledWith(
      'unauthorized',
      expect.objectContaining({ reason: 'No session token' }),
    );
  });

  it('still logs the unauthorized event for a browser page navigation with no session cookie', async () => {
    await middleware(buildRequest('/activate', { 'user-agent': BROWSER_UA }));

    expect(mockLogSecurityEvent).toHaveBeenCalledWith(
      'unauthorized',
      expect.objectContaining({ reason: 'No session token' }),
    );
  });

  it('changes nothing for the Electron shell when a session cookie IS present (pass-through, as for everyone)', async () => {
    mockGetSessionFromCookies.mockReturnValue('ps_sess_valid');

    const response = await middleware(buildRequest('/dashboard/drv_abc', { 'user-agent': ELECTRON_UA }));

    expect(response.status).not.toBe(307);
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
  });
});

// The desktop/native OAuth callbacks return their own styled HTML "handoff
// bridge" with a bespoke CSP that allows an inline <style> block. Middleware
// must tell createSecureResponse to skip its own CSP for these paths, so the two
// policies don't intersect and fall style-src back to default-src 'none'
// (which blocked the bridge's inline styles — the reported regression).
describe('middleware — handoff-bridge OAuth callbacks skip the middleware CSP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionFromCookies.mockReturnValue(undefined);
    mockValidateOriginForMiddleware.mockReturnValue({ valid: true, origin: null, skipped: true, reason: '' });
    mockIsOriginValidationBlocking.mockReturnValue(false);
  });

  it.each(['/api/auth/google/callback', '/api/auth/apple/callback'])(
    'calls createSecureResponse with skipCSP: true for %s',
    async (pathname) => {
      await middleware(buildRequest(pathname));

      expect(mockCreateSecureResponse).toHaveBeenCalledWith(
        expect.any(Boolean),
        expect.anything(),
        expect.objectContaining({ skipCSP: true }),
      );
    },
  );

  it('does NOT skip the CSP for a normal public API route (control)', async () => {
    await middleware(buildRequest('/api/auth/csrf'));

    expect(mockCreateSecureResponse).toHaveBeenCalledWith(
      expect.any(Boolean),
      expect.anything(),
      expect.objectContaining({ skipCSP: false }),
    );
  });
});
