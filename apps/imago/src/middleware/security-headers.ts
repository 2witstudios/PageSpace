import { NextResponse } from 'next/server';
import { storageCspSources } from '@pagespace/lib/security/storage-csp-sources';
import { isDevPreviewEnabled, resolveDevPreviewApex } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { previewFrameSrcEntry } from '@pagespace/lib/services/sandbox/preview/preview-host';

// Mirrors apps/web/src/middleware/security-headers.ts: a fresh nonce per
// request, forwarded to the render on the request headers (Next reads the CSP
// request header to stamp the nonce on its own scripts) and enforced in the
// browser on the response. The nonce/strict-dynamic script policy remains
// unchanged; retained billing/preview frames use classic deployment gates. Storage
// uses the existing deployment-configured endpoint/bucket rule for uploads.
// Edge runtime: keep this module free of Node-only imports.

export const NONCE_HEADER = 'x-nonce';

const HSTS_VALUE = 'max-age=63072000; includeSubDomains; preload';

const permissionsPolicy = (): string =>
  `geolocation=(), microphone=(self), camera=(), payment=${isStripeEnabled() ? '(self "https://js.stripe.com")' : '()'}`;
const isStripeEnabled = (): boolean => process.env.DEPLOYMENT_MODE !== 'onprem' && process.env.DEPLOYMENT_MODE !== 'tenant';

const shouldEmitHsts = ({
  isProduction,
  isSecure,
}: {
  isProduction: boolean;
  isSecure: boolean;
}): boolean => isProduction || isSecure;

/**
 * Whether the request arrived over HTTPS, honoring the `x-forwarded-proto`
 * header set by upstream proxies ahead of the request URL's own protocol.
 */
const isSecureRequest = (request: Request | undefined): boolean => {
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

export const generateNonce = (): string => btoa(crypto.randomUUID());

type CSPDirectives = Record<string, string[]>;

const buildCSPString = (directives: CSPDirectives): string =>
  Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ');

type CSPPolicyOptions = {
  /** `next dev` only: never set for a production build. */
  isDevelopment?: boolean;
  /** NEXT_PUBLIC_REALTIME_URL: its origin joins connect-src. */
  realtimeUrl?: string;
};

/**
 * The realtime server's origin as a connect-src source, or null when there is
 * none to add. socket.io opens with HTTP long-polling, which ws:/wss: do not
 * cover, so a realtime server on another origin (Docker Compose's :3001) is
 * unreachable without it. Only a plain http(s) origin is emitted: anything
 * else could smuggle extra sources or directives into the policy.
 */
const realtimeConnectSource = (realtimeUrl: string | undefined): string | null => {
  if (!realtimeUrl) return null;
  try {
    const { protocol, origin } = new URL(realtimeUrl);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(origin) ? origin : null;
  } catch {
    return null;
  }
};

export const buildCSPPolicy = (
  nonce: string,
  { isDevelopment = false, realtimeUrl }: CSPPolicyOptions = {},
): string => {
  const realtimeSource = realtimeConnectSource(realtimeUrl);
  const storageSources = storageCspSources(process.env.AWS_ENDPOINT_URL_S3, process.env.BUCKET_NAME ?? process.env.TIGRIS_BUCKET ?? process.env.S3_BUCKET ?? 'pagespace-files');
  const stripe = isStripeEnabled();
  const previewApex = isDevPreviewEnabled() ? resolveDevPreviewApex() : null;
  const frames = ["'self'", ...(previewApex ? [previewFrameSrcEntry(previewApex)] : []), ...(stripe ? ['https://js.stripe.com', 'https://hooks.stripe.com', 'https://m.stripe.network'] : [])];
  return buildCSPString({
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      "'unsafe-inline'", // Fallback for older browsers (ignored when strict-dynamic present)
      // React's development build rebuilds server component stacks with eval,
      // and without it hydration fails under `next dev`. Next's CSP guide adds
      // it for development only; a production build never gets it.
      ...(isDevelopment ? ["'unsafe-eval'"] : []),
    ],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'img-src': ["'self'", 'data:', 'blob:', 'https:', ...storageSources],
    // ws:/wss: for the realtime socket; its origin for socket.io's polling.
    'connect-src': ["'self'", 'ws:', 'wss:', ...(realtimeSource ? [realtimeSource] : []), ...storageSources, ...(stripe ? ['https://*.stripe.com', 'https://m.stripe.network'] : [])],
    'frame-src': frames,
    ...(storageSources.length ? { 'media-src': ["'self'", ...storageSources] } : {}),
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
    'worker-src': ["'self'", 'blob:'],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'object-src': ["'none'"],
  });
};

export const buildAPICSPPolicy = (): string =>
  buildCSPString({
    'default-src': ["'none'"],
    'frame-ancestors': ["'none'"],
  });

type SecurityHeadersOptions = {
  nonce: string;
  isDevelopment: boolean;
  realtimeUrl?: string;
  isProduction: boolean;
  isSecure: boolean;
  isAPIRoute: boolean;
  pathname?: string;
};

const applySecurityHeaders = (
  response: NextResponse,
  { nonce, isDevelopment, realtimeUrl, isProduction, isSecure, isAPIRoute, pathname }: SecurityHeadersOptions,
): NextResponse => {
  response.headers.set(
    'Content-Security-Policy',
    isAPIRoute ? buildAPICSPPolicy() : buildCSPPolicy(nonce, { isDevelopment, realtimeUrl }),
  );
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', permissionsPolicy());
  // Classic exempts its Stripe-dependent billing/plan routes from COEP.
  // Mirror only their native equivalents when cloud billing is enabled.
  const stripePage = isStripeEnabled() && (pathname === '/account/billing' || pathname === '/account/plan');
  if (!isAPIRoute && !stripePage) {
    response.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  }
  if (shouldEmitHsts({ isProduction, isSecure })) {
    response.headers.set('Strict-Transport-Security', HSTS_VALUE);
  }
  return response;
};

type CreateSecureResponseOptions = {
  /** Base-path-relative route, for the exact cloud billing embed exception. */
  pathname?: string;
  isAPIRoute?: boolean;
  /** The `next dev` server: adds 'unsafe-eval' to the document CSP. */
  isDevelopment?: boolean;
  /** NEXT_PUBLIC_REALTIME_URL: its origin joins the document's connect-src. */
  realtimeUrl?: string;
  /** Extra request headers for the render; each overwrites any client value. */
  forwardHeaders?: Record<string, string>;
};

export const createSecureResponse = (
  isProduction: boolean,
  request?: Request,
  { isAPIRoute = false, isDevelopment = false, realtimeUrl, pathname, forwardHeaders = {} }: CreateSecureResponseOptions = {},
): { response: NextResponse; nonce: string } => {
  const nonce = generateNonce();
  const isSecure = isSecureRequest(request);

  // CSP in the request headers lets Next.js parse the nonce during SSR and
  // apply it to framework scripts (getScriptNonceFromHeader).
  const requestHeaders = new Headers(request?.headers);
  for (const [name, value] of Object.entries(forwardHeaders)) {
    requestHeaders.set(name, value);
  }
  requestHeaders.set(NONCE_HEADER, nonce);
  if (!isAPIRoute) {
    requestHeaders.set('Content-Security-Policy', buildCSPPolicy(nonce, { isDevelopment, realtimeUrl }));
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applySecurityHeaders(response, { nonce, isDevelopment, realtimeUrl, isProduction, isSecure, isAPIRoute, pathname });

  return { response, nonce };
};
