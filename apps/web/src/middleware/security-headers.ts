import { NextResponse } from 'next/server';

export const NONCE_HEADER = 'x-nonce';

// Security headers for error responses (API routes)
const ERROR_RESPONSE_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

export const createSecureErrorResponse = (
  body: string | object,
  status: number,
  isProduction: boolean = false
): NextResponse => {
  const isJson = typeof body === 'object';
  const headers: Record<string, string> = {
    ...ERROR_RESPONSE_HEADERS,
    'Content-Type': isJson ? 'application/json' : 'text/plain',
  };

  if (isProduction) {
    headers['Strict-Transport-Security'] =
      'max-age=63072000; includeSubDomains; preload';
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

export const buildCSPPolicy = (nonce: string): string => {
  const directives: CSPDirectives = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      "'unsafe-inline'", // Fallback for older browsers (ignored when strict-dynamic present)
      'https://accounts.google.com', // Google One Tap authentication
      'https://cdn.jsdelivr.net', // Monaco editor CDN
    ],
    'style-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://accounts.google.com'],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'connect-src': ["'self'", 'ws:', 'wss:', 'https:'],
    'font-src': ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
    'frame-src': ['https://accounts.google.com'], // Google One Tap iframe
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
  isAPIRoute?: boolean;
};

export const applySecurityHeaders = (
  response: NextResponse,
  { nonce, isProduction, isAPIRoute = false }: SecurityHeadersOptions
): NextResponse => {
  const csp = isAPIRoute ? buildAPICSPPolicy() : buildCSPPolicy(nonce);

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=()'
  );

  if (isProduction) {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload'
    );
  }

  return response;
};

export const createSecureResponse = (
  isProduction: boolean,
  request?: Request,
  isAPIRoute: boolean = false
): { response: NextResponse; nonce: string } => {
  const nonce = generateNonce();
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
  applySecurityHeaders(response, { nonce, isProduction, isAPIRoute });

  return { response, nonce };
};
