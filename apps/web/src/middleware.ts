import { NextRequest, NextResponse } from 'next/server';
import { monitoringMiddleware } from '@/middleware/monitoring';
import {
  createSecureResponse,
  createSecureErrorResponse,
  isPublicPageRoute,
  isPublishedSiteHost,
  isSecureRequest,
  shouldDisableCOEP,
} from '@/middleware/security-headers';
import { logSecurityEvent } from '@pagespace/lib/logging/logger-config';
import {
  validateOriginForMiddleware,
  isOriginValidationBlocking,
  MCP_TOKEN_PREFIX,
  SESSION_TOKEN_PREFIX,
  OAUTH_ACCESS_TOKEN_PREFIX,
} from '@/lib/auth';
import { getSessionFromCookies } from '@/lib/auth/cookie-config';
import { WELL_KNOWN_REWRITES } from '@/lib/well-known/rewrites';

// Edge-safe middleware: only checks presence of auth tokens, not validity.
// Full validation happens in route handlers via verifyAuth()/validateMCPToken().
// Bearer prefixes are imported from the real auth layer, not hand-duplicated —
// see the export site for why (a duplicated ps_at_-less copy previously drifted
// out of sync here, undetected because middleware never ran in production).

const MCP_BEARER_PREFIX = `Bearer ${MCP_TOKEN_PREFIX}`;
const SESSION_BEARER_PREFIX = `Bearer ${SESSION_TOKEN_PREFIX}`;
const OAUTH_BEARER_PREFIX = `Bearer ${OAUTH_ACCESS_TOKEN_PREFIX}`;

const IS_ONPREM = process.env.DEPLOYMENT_MODE === 'onprem';
const IS_TENANT = process.env.DEPLOYMENT_MODE === 'tenant';
const IS_BILLING_DISABLED = IS_ONPREM || IS_TENANT;

/**
 * Routes blocked in on-prem and tenant modes. These return 404 to prevent probing.
 * Stripe, OAuth, and self-registration routes are inaccessible.
 * Magic-link and passkey routes are allowed everywhere (passwordless auth).
 */
const CLOUD_ONLY_ROUTE_PREFIXES = [
  '/api/stripe/',
  '/api/auth/google/',
  '/api/auth/apple/',
  '/api/auth/signup',
  '/api/auth/mobile/signup',
];

export async function middleware(req: NextRequest) {
  return monitoringMiddleware(req, async () => {
    const { pathname } = req.nextUrl;
    const isProduction = process.env.NODE_ENV === 'production';
    const isAPIRoute = pathname.startsWith('/api');

    // Published-page hosts (*.pagespace.site) are public and served from object
    // storage, not by this app. A request only reaches us via a proxy misroute
    // or mid-cutover state — it must never be auth-gated, so return a clean 404
    // instead of redirecting to /auth/signin.
    if (isPublishedSiteHost(req.headers.get('host'))) {
      const { response } = createSecureResponse(isProduction, req, { isAPIRoute });
      return new NextResponse(null, { status: 404, headers: response.headers });
    }

    // Non-cloud route blocking (defense-in-depth)
    // Runs before all other checks to prevent cloud-only routes from executing
    if (IS_BILLING_DISABLED && CLOUD_ONLY_ROUTE_PREFIXES.some(prefix => pathname.startsWith(prefix))) {
      const { response } = createSecureResponse(isProduction, req, { isAPIRoute: true });
      return new NextResponse(null, { status: 404, headers: response.headers });
    }
    // Public Canvas-form submission endpoint: no session (public by design —
    // visitors on a published site are never authenticated), and origin
    // validation is inapplicable — valid callers are arbitrary published-site
    // hosts/custom domains with no fixed allowlist. Origin/Referer must never
    // be the authorization decision for this route (the token hash lookup in
    // the route handler is); returning here means it's never even checked,
    // let alone allowed to block, regardless of ORIGIN_VALIDATION_MODE.
    if (pathname.startsWith('/api/public/forms/')) {
      const { response } = createSecureResponse(isProduction, req, { isAPIRoute: true });
      return response;
    }

    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0] ||
      req.headers.get('x-real-ip') ||
      'unknown';

    // Origin validation for API routes (defense-in-depth)
    if (pathname.startsWith('/api')) {
      const originResult = validateOriginForMiddleware(req);

      if (!originResult.valid && !originResult.skipped) {
        if (isOriginValidationBlocking()) {
          logSecurityEvent('origin_validation_failed', {
            pathname,
            origin: originResult.origin,
            reason: originResult.reason,
            action: 'blocked',
            ip,
          });
          return createSecureErrorResponse(
            { error: 'Origin not allowed', code: 'ORIGIN_INVALID' },
            403,
            isProduction,
            isSecureRequest(req)
          );
        }
        logSecurityEvent('origin_validation_warning', {
          pathname,
          origin: originResult.origin,
          reason: originResult.reason,
          action: 'allowed',
          ip,
        });
      }
    }

    // Bearer token format check (Edge-safe - no database access)
    // Full validation happens in route handlers via validateMCPToken()/validateSessionToken()/validateOAuthAccessToken()
    const authHeader = req.headers.get('authorization');
    if (
      authHeader?.startsWith(MCP_BEARER_PREFIX) ||
      authHeader?.startsWith(SESSION_BEARER_PREFIX) ||
      authHeader?.startsWith(OAUTH_BEARER_PREFIX)
    ) {
      // API routes get restrictive CSP (no nonce needed)
      const { response } = createSecureResponse(isProduction, req, { isAPIRoute: true });
      return response;
    }

    // Well-known discovery routes (e.g. RFC 8414 OAuth metadata) must be
    // reachable with no session — it's the first request the CLI login flow
    // makes. The App Router can't route `.`-prefixed folders, and next.config
    // rewrites() run AFTER the filesystem/prerender check: because
    // public/.well-known/ exists, Next serves that namespace a prerendered +
    // cached 404 before any rewrite phase can fire (observed in prod:
    // x-nextjs-prerender=1, x-nextjs-cache=HIT). Middleware runs BEFORE routing
    // and is never cached, so the rewrite to the routable API handler must
    // happen HERE. Match the pre-rewrite source pathname; this is also public
    // (no session), which is why it sits above the auth checks below.
    const wellKnown = WELL_KNOWN_REWRITES.find((rewrite) => rewrite.source === pathname);
    if (wellKnown) {
      return NextResponse.rewrite(new URL(wellKnown.destination, req.url));
    }

    // Public routes that don't require authentication
    // Note: Cron routes handle their own auth via validateSignedCronRequest (HMAC-SHA256 + nonce)
    // Device/mobile auth endpoints authenticate via body tokens (device token, magic link),
    // not session cookies, so they must bypass the cookie check to allow cookie-expired recovery.
    // OAuth grant endpoints are public by protocol design (RFC 6749/7009/8628): the CLI calls
    // them with no browser session at all, authenticating via client_id/code/refresh_token/
    // device_code in the request body instead — each route enforces its own auth internally
    // (authorize's POST still requires a session; token/revoke/device_authorization never do).
    // Exact matches only — device_authorization's /verify and /decision sub-routes are the
    // browser-side /activate screen and DO require a session, so must not be swept in here.
    // Third-party webhooks authenticate via their own signature/HMAC check inside route.ts,
    // never a session cookie or a recognized bearer prefix — each must be listed here or this
    // middleware (now that it actually runs) blocks them with a 401 before route.ts ever sees
    // the request.
    // Signup/verification endpoints run before any session exists by definition (that's what
    // they're creating), authenticating instead via login-CSRF token, WebAuthn challenge, a
    // one-time handoff token, or an emailed verification token. `/passkey/register` (and its
    // `/options` step) support an authenticated-session mode too — that's enforced inside the
    // route itself, not here; `/passkey/register/handoff` (which mints the handoff token) is
    // deliberately NOT in this list since it always requires a session.
    if (
      pathname.startsWith('/api/auth/csrf') ||
      pathname.startsWith('/api/auth/login-csrf') ||
      pathname.startsWith('/api/auth/magic-link/') ||
      pathname.startsWith('/api/auth/google') ||
      pathname.startsWith('/api/auth/passkey/authenticate') ||
      pathname.startsWith('/api/auth/device/') ||
      pathname.startsWith('/api/auth/mobile/') ||
      pathname.startsWith('/api/auth/desktop/') ||
      pathname.startsWith('/api/mcp/') ||
      pathname.startsWith('/api/drives') ||
      pathname.startsWith('/api/cron/') ||
      pathname === '/api/oauth/authorize' ||
      pathname === '/api/oauth/token' ||
      pathname === '/api/oauth/revoke' ||
      pathname === '/api/oauth/device_authorization' ||
      pathname === '/api/memory/cron' ||
      pathname === '/api/pulse/cron' ||
      pathname === '/api/integrations/zoom/webhook' ||
      pathname === '/api/stripe/webhook' ||
      pathname === '/api/integrations/google-calendar/webhook' ||
      pathname === '/api/auth/signup-passkey' ||
      pathname === '/api/auth/signup-passkey/options' ||
      pathname === '/api/auth/passkey/register' ||
      pathname === '/api/auth/passkey/register/options' ||
      pathname === '/api/auth/verify-email' ||
      pathname === '/api/health' ||
      pathname === '/api/version'
    ) {
      const { response } = createSecureResponse(isProduction, req, { isAPIRoute });
      return response;
    }

    // Public page routes (auth pages) get security headers but no session check
    if (isPublicPageRoute(pathname)) {
      const { response } = createSecureResponse(isProduction, req, { disableCOEP: shouldDisableCOEP(pathname) });
      return response;
    }

    // Session cookie presence check (Edge-safe - no database access)
    // Full validation happens in route handlers via verifyAuth()
    const cookieHeader = req.headers.get('cookie');
    const sessionToken = getSessionFromCookies(cookieHeader);

    if (!sessionToken) {
      logSecurityEvent('unauthorized', {
        pathname,
        reason: 'No session token',
        ip,
      });

      if (isAPIRoute) {
        return createSecureErrorResponse('Authentication required', 401, isProduction, isSecureRequest(req));
      }

      return NextResponse.redirect(new URL('/auth/signin', req.url));
    }

    // Session cookie exists - let request through
    // Route handlers will validate the session and check admin role
    const { response } = createSecureResponse(isProduction, req, { isAPIRoute, disableCOEP: shouldDisableCOEP(pathname) });

    return response;
  });
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico|sentry-tunnel).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
