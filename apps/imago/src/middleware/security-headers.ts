import { NextResponse } from 'next/server';

// Mirrors apps/web/src/middleware/security-headers.ts: a fresh nonce per
// request, forwarded to the render on the request headers (Next reads the CSP
// request header to stamp the nonce on its own scripts) and enforced in the
// browser on the response. Imago loads no third-party scripts or frames, so
// the policy omits apps/web's Google, Stripe, storage and preview entries.
// Edge runtime: keep this module free of Node-only imports.

export const NONCE_HEADER = 'x-nonce';

const HSTS_VALUE = 'max-age=63072000; includeSubDomains; preload';

const PERMISSIONS_POLICY = 'geolocation=(), microphone=(self), camera=(), payment=()';

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

export const buildCSPPolicy = (nonce: string): string =>
  buildCSPString({
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      "'unsafe-inline'", // Fallback for older browsers (ignored when strict-dynamic present)
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    // ws:/wss: for the realtime socket.
    'connect-src': ["'self'", 'ws:', 'wss:'],
    'font-src': ["'self'", 'data:'],
    'worker-src': ["'self'", 'blob:'],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'object-src': ["'none'"],
  });

export const buildAPICSPPolicy = (): string =>
  buildCSPString({
    'default-src': ["'none'"],
    'frame-ancestors': ["'none'"],
  });

type SecurityHeadersOptions = {
  nonce: string;
  isProduction: boolean;
  isSecure: boolean;
  isAPIRoute: boolean;
};

const applySecurityHeaders = (
  response: NextResponse,
  { nonce, isProduction, isSecure, isAPIRoute }: SecurityHeadersOptions,
): NextResponse => {
  response.headers.set(
    'Content-Security-Policy',
    isAPIRoute ? buildAPICSPPolicy() : buildCSPPolicy(nonce),
  );
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', PERMISSIONS_POLICY);
  if (!isAPIRoute) {
    response.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  }
  if (shouldEmitHsts({ isProduction, isSecure })) {
    response.headers.set('Strict-Transport-Security', HSTS_VALUE);
  }
  return response;
};

type CreateSecureResponseOptions = {
  isAPIRoute?: boolean;
};

export const createSecureResponse = (
  isProduction: boolean,
  request?: Request,
  { isAPIRoute = false }: CreateSecureResponseOptions = {},
): { response: NextResponse; nonce: string } => {
  const nonce = generateNonce();
  const isSecure = isSecureRequest(request);

  // CSP in the request headers lets Next.js parse the nonce during SSR and
  // apply it to framework scripts (getScriptNonceFromHeader).
  const requestHeaders = new Headers(request?.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  if (!isAPIRoute) {
    requestHeaders.set('Content-Security-Policy', buildCSPPolicy(nonce));
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applySecurityHeaders(response, { nonce, isProduction, isSecure, isAPIRoute });

  return { response, nonce };
};
