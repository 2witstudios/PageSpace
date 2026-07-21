import { NextRequest, NextResponse } from 'next/server';
import type { NextFetchEvent } from 'next/server';
import { monitoringMiddleware } from '@/middleware/monitoring';
import {
  applyApiCorsHeaders,
  createSecureResponse,
  createSecureRewrite,
  createSecureErrorResponse,
  isHandoffBridgeRoute,
  isPublicPageRoute,
  isPublishedSiteHost,
  isSecureRequest,
  shouldDisableCOEP,
} from '@/middleware/security-headers';
import { isSafeNextPath, SIGNIN_NEXT_ALLOWED_PREFIXES } from '@/lib/auth/url-utils';
import { logSecurityEvent } from '@/lib/logging/edge-logger';
import {
  validateOriginForMiddleware,
  isOriginValidationBlocking,
} from '@/lib/auth/origin-validation';
import {
  MCP_TOKEN_PREFIX,
  SESSION_TOKEN_PREFIX,
  OAUTH_ACCESS_TOKEN_PREFIX,
} from '@/lib/auth/token-prefixes';
import { getSessionFromCookies } from '@/lib/auth/cookie-config';
import { isElectronShell } from '@/lib/auth/native-shell';
import { WELL_KNOWN_REWRITES } from '@/lib/well-known/rewrites';
import { getClientIP } from '@/lib/security/edge-client-ip';

// Edge-safe middleware: only checks presence of auth tokens, not validity.
// Full validation happens in route handlers via verifyAuth()/validateMCPToken().
// Every import above must stay edge-safe — leaf modules only, NEVER the
// '@/lib/auth' barrel (Node-only graph: db, sessions, permissions) and never
// @pagespace/lib's logger. Bearer prefixes come from the token-prefixes leaf
// the auth layer itself re-exports, not a hand-duplicated copy — a duplicated
// ps_at_-less copy previously drifted out of sync here, undetected because
// middleware never ran in production.

const MCP_BEARER_PREFIX = `Bearer ${MCP_TOKEN_PREFIX}`;
const SESSION_BEARER_PREFIX = `Bearer ${SESSION_TOKEN_PREFIX}`;
const OAUTH_BEARER_PREFIX = `Bearer ${OAUTH_ACCESS_TOKEN_PREFIX}`;

const SIGNIN_PATH = '/auth/signin';

// The iOS shell remote-loads https://pagespace.ai/dashboard (apps/ios/capacitor.config.ts).
// Capacitor decides every top-level navigation in WebViewDelegationHandler.swift:98-116:
// with no `server.allowNavigation` the host allowlist is empty, so it falls through to a
// raw string-prefix test of the target URL against `server.url` — path included. A signin
// *redirect* fails that test, gets opened in system Safari, and is cancelled in the
// WebView, which is then left holding no document at all: the black screen. A *rewrite*
// is not a navigation, so the policy delegate is never consulted and the signin page just
// renders in place. Only /dashboard needs this — it is the shell's sole entry point — and
// scoping it there keeps the honest redirect (and its correct URL bar) everywhere else.
const REWRITE_SIGNIN_ROOT = '/dashboard';

const isShellEntryPath = (pathname: string): boolean =>
  pathname === REWRITE_SIGNIN_ROOT || pathname.startsWith(`${REWRITE_SIGNIN_ROOT}/`);

// Query params that must never survive into `next=`. `next` itself, because the
// destination is always the path actually requested — honouring a caller-supplied
// `next` instead would let a query param override the real destination, and leaving a
// rejected one embedded would fail validation for the whole reconstructed path and cost
// the user the rest of their query string with it. `_rsc` because a soft navigation that
// finds an expired session carries Next's RSC cache-buster, which is meaningless (and
// stale) by the time the user is landed back on the page after signing in.
const NON_FORWARDABLE_PARAMS = ['next', '_rsc'];

/**
 * Signin URL for the REDIRECT path, carrying the deep link the user was denied so signin
 * can return them there. The deep link is always reconstructed from the request itself;
 * only destinations the signin surface actually accepts survive, and anything else is
 * dropped rather than passed along to be rejected there.
 *
 * Deliberately NOT used for the rewrite. A rewrite leaves the browser URL alone, so under
 * one the browser is still sitting on the deep link and the client reads it straight off
 * the path (resolve-signin-next.ts). Putting `next=` on the rewrite destination as well
 * would have the server render a value the client cannot see — and `nextPath` reaches the
 * DOM (the signup link's href), so that is a hydration mismatch. Omitting it keeps server
 * and client in agreement on every reachable flow.
 */
const buildSigninUrl = (req: NextRequest): URL => {
  // Resolved against req.url, so the origin is always this request's own — a rewrite
  // to a *foreign* origin would be a server-side proxy instruction rather than a
  // client-side hop, but that is unreachable here by construction, however the Host
  // header is set. Same idiom as the WELL_KNOWN_REWRITES rewrite below.
  const url = new URL(SIGNIN_PATH, req.url);

  const search = new URLSearchParams(req.nextUrl.search);
  for (const param of NON_FORWARDABLE_PARAMS) search.delete(param);
  const query = search.toString();
  const candidate = query ? `${req.nextUrl.pathname}?${query}` : req.nextUrl.pathname;

  if (isSafeNextPath({ path: candidate, allowedPrefixes: SIGNIN_NEXT_ALLOWED_PREFIXES })) {
    url.searchParams.set('next', candidate);
  }

  return url;
};

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

export async function middleware(req: NextRequest, event?: NextFetchEvent) {
  // `event` lets the monitoring layer register its ingest POST with
  // waitUntil(), so the Edge runtime can't cancel it when the response
  // returns — it is the only persistence path for API metrics.
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

    const ip = getClientIP(req);

    // CORS preflight for the Bearer-authenticated API surface (@pagespace/sdk and
    // any other Bearer-token caller). Browsers never send Authorization (or
    // cookies) on a preflight OPTIONS request, so the Bearer-prefix detection
    // below can't tell a preflight apart from an anonymous same-origin OPTIONS —
    // this short-circuit must be unconditional. It grants no access by itself:
    // the real GET/POST/etc. that follows still goes through full, normal auth.
    if (isAPIRoute && req.method === 'OPTIONS') {
      return applyApiCorsHeaders(new NextResponse(null, { status: 204 }));
    }

    // Bearer token format check (Edge-safe - no database access), run BEFORE
    // origin validation below. Bearer-authenticated requests are already
    // CSRF/Origin-immune at the route layer (`isSessionAuth` gates both checks
    // in apps/web/src/lib/auth/index.ts — CSRF/Origin only apply to cookie
    // sessions), so this middleware must skip origin validation for them too,
    // and must attach CORS response headers so a cross-origin browser caller
    // (e.g. the SDK) can actually read the response.
    // Full validation happens in route handlers via validateMCPToken()/validateSessionToken()/validateOAuthAccessToken()
    const authHeader = req.headers.get('authorization');
    if (
      authHeader?.startsWith(MCP_BEARER_PREFIX) ||
      authHeader?.startsWith(SESSION_BEARER_PREFIX) ||
      authHeader?.startsWith(OAUTH_BEARER_PREFIX)
    ) {
      // API routes get restrictive CSP (no nonce needed)
      const { response } = createSecureResponse(isProduction, req, { isAPIRoute: true });
      return applyApiCorsHeaders(response);
    }

    // Origin validation for API routes (defense-in-depth). Bearer-authenticated
    // requests never reach here — they returned above — so this only ever
    // enforces against cookie-session traffic, unchanged from before.
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
    // `/api/webhooks/[token]` is the page incoming-webhook intake: external senders (CI,
    // monitoring, scripts) have no session and authenticate via the per-webhook HMAC
    // signature verified inside the route — same rationale as the third-party webhooks.
    // Signup/verification endpoints run before any session exists by definition (that's what
    // they're creating), authenticating instead via login-CSRF token, WebAuthn challenge, a
    // one-time handoff token, or an emailed verification token. `/passkey/register` (and its
    // `/options` step) support an authenticated-session mode too — that's enforced inside the
    // route itself, not here; `/passkey/register/handoff` (which mints the handoff token) is
    // deliberately NOT in this list since it always requires a session.
    // `/api/auth/apple/` mirrors the existing `/api/auth/google` carve-out above: OAuth
    // initiation (signin) and the provider callback both run with no session yet.
    // `/api/auth/step-up/magic-link/verify` is the click-through target of a step-up
    // confirmation email — like `/api/auth/verify-email`, it authenticates via the emailed
    // token alone and (per its own doc comment) never creates a session.
    // `/api/auth/logout` must stay reachable with NO session cookie: per its own comment, it
    // still needs to revoke a device token by value when the cookie is already missing or
    // expired — exactly the moment that token is the only credential left to invalidate.
    // `/api/internal/*` (contact, monitoring/ingest) authenticate via a shared secret in a
    // custom header or a non-prefixed Bearer value — never a session or a recognized MCP/
    // session/OAuth bearer prefix — same rationale as the webhooks above.
    // `/api/notifications/unsubscribe/[token]` is an opaque-token email unsubscribe link,
    // clicked by (often logged-out) recipients.
    // `/api/ai/models`, `/api/compiled-css`, `/api/avatar/[userId]/[filename]`, and
    // `/api/provisioning-status/[slug]` are public-by-design per this codebase's own
    // apps/web/src/app/api/__tests__/security-audit-coverage.test.ts allowlist (model
    // catalog, static CSS, public avatar images, tenant-onboarding status polling) and call
    // no auth function at all — confirmed by reading each route.ts directly.
    // `/api/contact` is the public marketing contact form (ContactForm.tsx), unauthenticated
    // by design.
    if (
      pathname.startsWith('/api/auth/csrf') ||
      pathname.startsWith('/api/auth/login-csrf') ||
      pathname.startsWith('/api/auth/magic-link/') ||
      pathname.startsWith('/api/auth/google') ||
      pathname.startsWith('/api/auth/apple/') ||
      pathname.startsWith('/api/auth/passkey/authenticate') ||
      pathname.startsWith('/api/auth/device/') ||
      pathname.startsWith('/api/auth/mobile/') ||
      pathname.startsWith('/api/auth/desktop/') ||
      pathname.startsWith('/api/internal/') ||
      pathname.startsWith('/api/notifications/unsubscribe/') ||
      pathname.startsWith('/api/avatar/') ||
      pathname.startsWith('/api/provisioning-status/') ||
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
      pathname.startsWith('/api/webhooks/') ||
      pathname === '/api/auth/signup-passkey' ||
      pathname === '/api/auth/signup-passkey/options' ||
      pathname === '/api/auth/passkey/register' ||
      pathname === '/api/auth/passkey/register/options' ||
      pathname === '/api/auth/verify-email' ||
      pathname === '/api/auth/step-up/magic-link/verify' ||
      pathname === '/api/auth/logout' ||
      pathname === '/api/ai/models' ||
      pathname === '/api/compiled-css' ||
      pathname === '/api/contact' ||
      pathname === '/api/health' ||
      pathname === '/api/version'
    ) {
      // Handoff-bridge OAuth callbacks (google/apple) return their own styled HTML
      // with a bespoke CSP — skip the middleware CSP so it doesn't intersect with
      // and clobber the route's policy (which allows the page's inline styles).
      const { response } = createSecureResponse(isProduction, req, {
        isAPIRoute,
        skipCSP: isHandoffBridgeRoute(pathname),
      });
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

      // Electron desktop shell: its page navigations carry COOKIES while the
      // real credential (the Bearer token) lives in the Electron main process
      // and is attached per API call — so a missing/stale session cookie says
      // nothing about whether the desktop user is authenticated. Bouncing the
      // shell to the signin form here IS the desktop "random logout". Let the
      // page load and let the shell recover client-side via its Bearer. This
      // relaxes only the navigation UX gate, never an auth boundary: the page
      // shell is public and all data still comes from Bearer-validated API
      // routes (the isAPIRoute 401 above is untouched). The iOS/Capacitor
      // /dashboard rewrite below is a different shell (no Electron/ UA token)
      // and keeps its own handling.
      if (isElectronShell(req.headers.get('user-agent'))) {
        const { response } = createSecureResponse(isProduction, req, {
          isAPIRoute,
          disableCOEP: shouldDisableCOEP(pathname),
        });
        return response;
      }

      if (isShellEntryPath(pathname)) {
        // A `next=` on a /dashboard URL is visible to the client (which reads the browser
        // URL) but NOT to the server (which renders the bare rewrite destination), and
        // nextPath reaches the DOM — so such a URL would desync the two renders. Nothing
        // in the app produces one, but a hand-crafted one must not be able to provoke a
        // hydration mismatch, so strip it with a redirect and let the clean URL rewrite.
        // Safe under the iOS shell: the target is still under /dashboard, so it passes
        // Capacitor's prefix test. No loop — the redirected URL has no `next` left.
        if (req.nextUrl.searchParams.has('next')) {
          const clean = new URL(req.url);
          clean.searchParams.delete('next');
          return NextResponse.redirect(clean);
        }

        // Bare /auth/signin, with no `next=` — see buildSigninUrl. The browser URL is
        // untouched by a rewrite, so it IS still the deep link and the client recovers it
        // from there; carrying it here as well would desync the server render from the
        // client's.
        //
        // disableCOEP mirrors what the /auth/* branch above would have applied: the signin
        // page's OAuth popups and Google One Tap iframe need it, and under the rewrite
        // shouldDisableCOEP() only ever sees the /dashboard pathname.
        const { response } = createSecureRewrite(
          new URL(SIGNIN_PATH, req.url),
          isProduction,
          req,
          { disableCOEP: true },
        );
        return response;
      }

      return NextResponse.redirect(buildSigninUrl(req));
    }

    // Session cookie exists - let request through
    // Route handlers will validate the session and check admin role
    const { response } = createSecureResponse(isProduction, req, { isAPIRoute, disableCOEP: shouldDisableCOEP(pathname) });

    return response;
  }, event);
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
