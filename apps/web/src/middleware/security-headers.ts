import { NextResponse } from 'next/server';

export const NONCE_HEADER = 'x-nonce';

export const generateNonce = (): string =>
  Buffer.from(crypto.randomUUID()).toString('base64');

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
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'connect-src': ["'self'", 'ws:', 'wss:', 'https:'],
    'font-src': ["'self'", 'data:'],
    'frame-src': ['https://accounts.google.com'], // Google One Tap iframe
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
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

  // Clone request headers and add nonce so it's available in layout via headers()
  const requestHeaders = new Headers(request?.headers);
  requestHeaders.set(NONCE_HEADER, nonce);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  applySecurityHeaders(response, { nonce, isProduction, isAPIRoute });

  return { response, nonce };
};
