import { NextResponse } from 'next/server';
import { API_CONTRACT_VERSION } from '@pagespace/lib/api-contract-version';

export const NONCE_HEADER = 'x-nonce';

const HSTS_VALUE = 'max-age=63072000; includeSubDomains; preload';

/**
 * Decide whether to emit HSTS (GDPR #969). Emitted for ANY HTTPS response so
 * non-production-but-HTTPS environments (staging, tenant, preview) are not
 * silently left without transit protection. `isProduction` is retained for
 * back-compat — production always emits even if scheme detection is unavailable.
 */
export const shouldEmitHsts = ({
  isProduction,
  isSecure,
}: {
  isProduction: boolean;
  isSecure?: boolean;
}): boolean => isProduction || isSecure === true;

/**
 * Determine whether an inbound request arrived over HTTPS, honoring the
 * `x-forwarded-proto` header set by upstream proxies (Caddy/Fly) ahead of the
 * request URL's own protocol.
 */
export const isSecureRequest = (request: Request | undefined): boolean => {
  if (!request) return false;
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) {
    return forwarded.split(',')[0].trim().toLowerCase() === 'https';
  }
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
};

const PERMISSIONS_POLICY =
  'geolocation=(), microphone=(self), camera=(), payment=(self "https://js.stripe.com")';

// Security headers for error responses (API routes)
const ERROR_RESPONSE_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': PERMISSIONS_POLICY,
  'X-PageSpace-API-Version': API_CONTRACT_VERSION,
};

export const createSecureErrorResponse = (
  body: string | object,
  status: number,
  isProduction: boolean = false,
  isSecure: boolean = false
): NextResponse => {
  const isJson = typeof body === 'object';
  const headers: Record<string, string> = {
    ...ERROR_RESPONSE_HEADERS,
    'Content-Type': isJson ? 'application/json' : 'text/plain',
  };

  if (shouldEmitHsts({ isProduction, isSecure })) {
    headers['Strict-Transport-Security'] = HSTS_VALUE;
  }

  return new NextResponse(isJson ? JSON.stringify(body) : body, {
    status,
    headers,
  });
};

export const generateNonce = (): string => btoa(crypto.randomUUID());

type CSPDirectives = Record<string, string[]>;

const buildCSPString = (directives: CSPDirectives): string =>
  Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ');

const IS_CLOUD = process.env.DEPLOYMENT_MODE !== 'onprem' && process.env.DEPLOYMENT_MODE !== 'tenant';

/**
 * Bucket-name env-var precedence, mirrored from `apps/web/src/lib/presigned-url.ts`'s
 * `getS3Bucket()`. DUPLICATED rather than imported: that module pulls in the
 * Node-only AWS SDK (`@aws-sdk/client-s3`), which this file cannot import —
 * `security-headers.ts` is loaded by the Edge-runtime `middleware.ts`, and a
 * Node-only import here would risk the exact class of outage the edge-safety
 * remediation (leaf-module contract, build-time Node-import guard in
 * `next.config.ts`) exists to prevent.
 */
const getStorageBucketName = (): string =>
  process.env.BUCKET_NAME ?? process.env.TIGRIS_BUCKET ?? process.env.S3_BUCKET ?? 'pagespace-files';

/**
 * Allowlist the configured S3-compatible object-storage endpoint for
 * `connect-src`, so direct-to-storage presigned uploads/downloads (browser
 * PUT/GET straight to Tigris, or another S3-compatible host in onprem/tenant
 * deployments) aren't blocked by the app-wide CSP.
 *
 * Derived from `AWS_ENDPOINT_URL_S3` at policy-build time — never hardcode a
 * literal host (e.g. `fly.storage.tigris.dev`), since onprem/tenant
 * deployments (`deployment-mode.ts`) may point this at a different
 * S3-compatible endpoint entirely.
 *
 * Emits the literal endpoint origin PLUS this app's own bucket subdomain
 * (`<bucket>.<host>`) — never a bare `*.<host>` wildcard. The AWS SDK v3
 * client (`presigned-url.ts`) has no `forcePathStyle`, so it defaults to
 * virtual-hosted-style addressing (bucket-as-subdomain), which the exact
 * bucket entry covers; the literal origin is kept as a defensive fallback for
 * any path-style usage. A bare `*.<host>` wildcard would additionally allow
 * connect-src/media-src to any OTHER tenant's bucket on a shared multi-tenant
 * host like Tigris or AWS S3 — anyone can self-serve-provision a bucket on
 * the same provider domain, so that wildcard would hand a future XSS an
 * attacker-controlled exfiltration target this app never intended to allow.
 *
 * Also reused verbatim for `media-src`: `/api/files/[id]/view` 307-redirects
 * `<video>`/`<audio>` element requests straight to this same presigned storage
 * URL, and CSP fetch directives are re-evaluated against the final redirected
 * URL — so media playback needs the identical host list, not just fetch/XHR.
 */
const buildStorageConnectSrcEntries = (): string[] => {
  const endpoint = process.env.AWS_ENDPOINT_URL_S3;
  if (!endpoint) return [];
  try {
    const { protocol, host } = new URL(endpoint);
    const bucket = getStorageBucketName();
    return [`${protocol}//${host}`, `${protocol}//${bucket}.${host}`];
  } catch {
    return [];
  }
};

export const buildCSPPolicy = (nonce: string): string => {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    "'unsafe-inline'", // Fallback for older browsers (ignored when strict-dynamic present)
  ];
  const styleSrc = ["'self'", "'unsafe-inline'"];
  const frameSrc: string[] = [];

  // Cloud-only: Google and Stripe external origins
  if (IS_CLOUD) {
    scriptSrc.push('https://accounts.google.com', 'https://js.stripe.com', 'https://m.stripe.network');
    styleSrc.push('https://accounts.google.com');
    // hooks.stripe.com hosts the 3D Secure challenge iframe; m.stripe.network is Stripe.js's
    // fraud-detection beacon frame. Without these, confirmPayment() hangs forever on 3DS.
    frameSrc.push('https://accounts.google.com', 'https://js.stripe.com', 'https://hooks.stripe.com', 'https://m.stripe.network');
  }

  const storageEntries = buildStorageConnectSrcEntries();
  const connectSrc = ["'self'", 'ws:', 'wss:', ...storageEntries];

  // Cloud mode: allow Stripe client SDK and Google One Tap connections
  if (IS_CLOUD) {
    // *.stripe.com does not match the .network TLD, so m.stripe.network needs its own entry.
    connectSrc.push('https://accounts.google.com', 'https://*.stripe.com', 'https://m.stripe.network');
  }

  const directives: CSPDirectives = {
    'default-src': ["'self'"],
    'script-src': scriptSrc,
    'style-src': styleSrc,
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'connect-src': connectSrc,
    // <video>/<audio> loading falls back to default-src when this is absent —
    // /api/files/[id]/view redirects media requests straight to the storage
    // host, so it needs the same allowlist as connect-src (see comment above).
    'media-src': ["'self'", ...storageEntries],
    'font-src': ["'self'", 'data:'],
    // Monaco and other browser tooling may initialize workers from blob URLs.
    'worker-src': ["'self'", 'blob:'],
    ...(frameSrc.length > 0 ? { 'frame-src': frameSrc } : {}),
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'object-src': ["'none'"], // Prevent Flash/plugin-based attacks
  };

  return buildCSPString(directives);
};

export const buildAPICSPPolicy = (): string => {
  const directives: CSPDirectives = {
    'default-src': ["'none'"],
    'frame-ancestors': ["'none'"],
  };

  return buildCSPString(directives);
};

type SecurityHeadersOptions = {
  nonce: string;
  isProduction: boolean;
  isSecure?: boolean;
  isAPIRoute?: boolean;
  disableCOEP?: boolean;
};

export const applySecurityHeaders = (
  response: NextResponse,
  { nonce, isProduction, isSecure = false, isAPIRoute = false, disableCOEP = false }: SecurityHeadersOptions
): NextResponse => {
  const csp = isAPIRoute ? buildAPICSPPolicy() : buildCSPPolicy(nonce);

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', PERMISSIONS_POLICY);
  response.headers.set('X-PageSpace-API-Version', API_CONTRACT_VERSION);
  // COEP 'credentialless' is set for all page routes except Stripe-dependent
  // paths (/settings/plan, /settings/billing) where it blocks Stripe.js loading
  // via no-cors without Cross-Origin-Resource-Policy headers.
  if (!isAPIRoute && !disableCOEP) {
    response.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  }

  if (shouldEmitHsts({ isProduction, isSecure })) {
    response.headers.set('Strict-Transport-Security', HSTS_VALUE);
  }

  return response;
};

// CORS for the Bearer-authenticated API surface (`@pagespace/sdk` and any other
// Bearer-token caller — MCP API keys, OAuth access tokens). Wildcard origin
// mirrors the existing precedent in api/public/forms/[token]/submit/route.ts:
// Bearer tokens require explicit JS header-setting (unlike cookies), so a
// wildcard doesn't expose a visitor's own session to a malicious page the way
// it would for cookie auth. `Access-Control-Expose-Headers` is required, not
// optional — the SDK reads X-PageSpace-API-Version (version-compat check) and
// Retry-After (429 backoff) directly off the response, and neither is in the
// CORS default-safelisted response-header set; omitting this makes every
// cross-origin call fail with IncompatibleServerError even though CORS itself
// "succeeded".
export const API_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-PageSpace-API-Version',
  'Access-Control-Expose-Headers': 'X-PageSpace-API-Version, Retry-After',
};

export const applyApiCorsHeaders = (response: NextResponse): NextResponse => {
  for (const [key, value] of Object.entries(API_CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
};

export const isPublicPageRoute = (pathname: string): boolean =>
  pathname === '/auth' ||
  pathname.startsWith('/auth/') ||
  pathname === '/invite' ||
  pathname.startsWith('/invite/') ||
  pathname.startsWith('/s/');

// Published Canvas pages live on *.pagespace.site and are served from object
// storage, never by this app. If such a request reaches us (proxy misroute /
// cutover), it must never be auth-gated — return 404, not a login redirect.
// Mirrors PUBLISH_HOST in app/api/pages/[pageId]/publish/route.ts.
export const PUBLISH_BASE_HOST = 'pagespace.site';

export const isPublishedSiteHost = (host: string | null | undefined): boolean => {
  if (!host) return false;
  const hostname = host.split(':')[0].toLowerCase(); // strip any port
  return hostname === PUBLISH_BASE_HOST || hostname.endsWith(`.${PUBLISH_BASE_HOST}`);
};

export const shouldDisableCOEP = (pathname: string): boolean =>
  pathname.startsWith('/settings/plan') ||
  pathname.startsWith('/settings/billing') ||
  pathname === '/auth' ||
  pathname.startsWith('/auth/');

type CreateSecureResponseOptions = {
  isAPIRoute?: boolean;
  disableCOEP?: boolean;
};

export const createSecureResponse = (
  isProduction: boolean,
  request?: Request,
  options: CreateSecureResponseOptions = {},
): { response: NextResponse; nonce: string } => {
  const { isAPIRoute = false, disableCOEP = false } = options;
  const nonce = generateNonce();
  const isSecure = isSecureRequest(request);
  const csp = isAPIRoute ? buildAPICSPPolicy() : buildCSPPolicy(nonce);

  // Clone request headers and add nonce + CSP
  // CSP in request headers allows Next.js to parse nonce during SSR
  // and automatically apply it to framework scripts (via getScriptNonceFromHeader)
  const requestHeaders = new Headers(request?.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  if (!isAPIRoute) {
    requestHeaders.set('Content-Security-Policy', csp);
  }

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // Also set CSP on response headers for browser enforcement
  applySecurityHeaders(response, { nonce, isProduction, isSecure, isAPIRoute, disableCOEP });

  return { response, nonce };
};
