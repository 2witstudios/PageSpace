import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import nextConfig from '../next.config';
import { config, middleware } from './middleware';
import { NONCE_HEADER, buildAPICSPPolicy, buildCSPPolicy } from './middleware/security-headers';
import { PATHNAME_HEADER } from './lib/auth/sign-in-url';

type RequestOptions = { session?: string | null; headers?: Record<string, string> };

// Signed in by default: the CSP tests below are about a request that passes the gate.
const imagoRequest = (
  pathname: string,
  { session = 'ps_sess_test', headers = {} }: RequestOptions = {},
): NextRequest =>
  new NextRequest(`http://localhost:3006${pathname}`, {
    nextConfig: { basePath: '/imago' },
    headers: session === null ? headers : { ...headers, cookie: `session=${session}` },
  });

const redirectOf = (response: Response): { status: number; location: URL | null } => {
  const location = response.headers.get('location');
  return {
    status: response.status,
    location: location ? new URL(location, 'http://localhost:3006') : null,
  };
};

describe('middleware()', () => {
  test('document request', () => {
    const response = middleware(imagoRequest('/imago/drive-1/files'));
    const nonce = response.headers.get(`x-middleware-request-${NONCE_HEADER}`);

    assert({
      given: 'a page request',
      should: 'mint a nonce for the render',
      actual: typeof nonce === 'string' && nonce.length > 0,
      expected: true,
    });

    assert({
      given: 'a page request',
      should: 'enforce the CSP carrying that nonce',
      actual: response.headers.get('Content-Security-Policy'),
      expected: buildCSPPolicy(nonce ?? ''),
    });
  });

  test('per-request nonce', () => {
    const first = middleware(imagoRequest('/imago'));
    const second = middleware(imagoRequest('/imago'));

    assert({
      given: 'two page requests',
      should: 'mint a fresh nonce for each',
      actual:
        first.headers.get(`x-middleware-request-${NONCE_HEADER}`) ===
        second.headers.get(`x-middleware-request-${NONCE_HEADER}`),
      expected: false,
    });
  });

  test('API request', () => {
    const response = middleware(imagoRequest('/imago/api/health'));

    assert({
      given: 'a request under /imago/api',
      should: 'apply the deny-all API CSP',
      actual: response.headers.get('Content-Security-Policy'),
      expected: buildAPICSPPolicy(),
    });
  });
});

describe('middleware() auth gate', () => {
  test('no session cookie', () => {
    const { status, location } = redirectOf(
      middleware(imagoRequest('/imago/drive-1/files', { session: null })),
    );

    assert({
      given: 'a page request with no session cookie',
      should: 'redirect temporarily',
      actual: status,
      expected: 307,
    });

    assert({
      given: 'a page request with no session cookie',
      should: "send it to classic's sign-in, outside the basePath",
      actual: location?.pathname,
      expected: '/auth/signin',
    });

    assert({
      given: 'a page request with no session cookie',
      should: 'carry the requested imago path as next=',
      actual: location?.searchParams.get('next'),
      expected: '/imago/drive-1/files',
    });

    assert({
      given: 'a page request with no session cookie',
      should: 'stay on the request origin',
      actual: location?.origin,
      expected: 'http://localhost:3006',
    });
  });

  test('the imago root', () => {
    const { location } = redirectOf(middleware(imagoRequest('/imago', { session: null })));

    assert({
      given: 'the bare /imago root with no session cookie',
      should: 'return there after sign-in',
      actual: location?.searchParams.get('next'),
      expected: '/imago',
    });
  });

  test('an empty session cookie', () => {
    const { status } = redirectOf(middleware(imagoRequest('/imago/drive-1', { session: '' })));

    assert({
      given: 'a session cookie with no value',
      should: 'treat it as signed out',
      actual: status,
      expected: 307,
    });
  });

  test('next= comes from the pathname only', () => {
    const { location } = redirectOf(
      middleware(
        imagoRequest('/imago/drive-1?next=https://evil.com&_rsc=abc', { session: null }),
      ),
    );

    assert({
      given: 'a request carrying its own next= query parameter',
      should: 'ignore it and use the requested pathname',
      actual: location?.searchParams.get('next'),
      expected: '/imago/drive-1',
    });

    const smuggled = redirectOf(middleware(imagoRequest('/imago//evil.com', { session: null })));

    assert({
      given: 'a protocol-relative look-alike path',
      should: 'fall back to the bare /imago root',
      actual: smuggled.location?.searchParams.get('next'),
      expected: '/imago',
    });
  });

  test('other cookies', () => {
    const { status } = redirectOf(
      middleware(
        imagoRequest('/imago/drive-1', {
          session: null,
          headers: { cookie: 'ps_logged_in=1; admin_session=ps_sess_x' },
        }),
      ),
    );

    assert({
      given: 'only the logged-in hint and an admin session cookie',
      should: 'still redirect (neither is the web session)',
      actual: status,
      expected: 307,
    });
  });

  test('health is public', () => {
    const response = middleware(imagoRequest('/imago/api/health', { session: null }));

    assert({
      given: 'the health route with no session cookie',
      should: 'pass through without a redirect',
      actual: response.headers.get('location'),
      expected: null,
    });

    assert({
      given: 'the health route with no session cookie',
      should: 'still apply the API CSP',
      actual: response.headers.get('Content-Security-Policy'),
      expected: buildAPICSPPolicy(),
    });

    const lookalike = redirectOf(
      middleware(imagoRequest('/imago/api/healthz', { session: null })),
    );

    assert({
      given: 'a route that only starts with the health path',
      should: 'still require a session',
      actual: lookalike.status,
      expected: 307,
    });
  });

  test('pathname forwarded to the render', () => {
    const response = middleware(imagoRequest('/imago/drive-1/files'));

    assert({
      given: 'a signed-in page request',
      should: 'forward the basePath-relative pathname for getViewer()',
      actual: response.headers.get(`x-middleware-request-${PATHNAME_HEADER}`),
      expected: '/drive-1/files',
    });

    const spoofed = middleware(
      imagoRequest('/imago/drive-1', { headers: { [PATHNAME_HEADER]: '//evil.com' } }),
    );

    assert({
      given: 'a client-supplied pathname header',
      should: "overwrite it with the request's own pathname",
      actual: spoofed.headers.get(`x-middleware-request-${PATHNAME_HEADER}`),
      expected: '/drive-1',
    });
  });
});

describe('middleware config.matcher', () => {
  const matches = (url: string, headers: Record<string, string> = {}): boolean =>
    unstable_doesMiddlewareMatch({ config, nextConfig, url, headers });

  test('pages and API routes under the basePath', () => {
    assert({
      given: 'the imago root /imago',
      should: 'run middleware so the page gets a nonce CSP',
      actual: matches('/imago'),
      expected: true,
    });

    assert({
      given: 'a nested page',
      should: 'run middleware',
      actual: matches('/imago/drive-1/files'),
      expected: true,
    });

    assert({
      given: 'the health route',
      should: 'run middleware',
      actual: matches('/imago/api/health'),
      expected: true,
    });
  });

  test('requests middleware skips', () => {
    assert({
      given: 'a static chunk',
      should: 'skip middleware',
      actual: matches('/imago/_next/static/chunks/main.js'),
      expected: false,
    });

    assert({
      given: 'a router prefetch',
      should: 'skip middleware',
      actual: matches('/imago/drive-1', { 'next-router-prefetch': '1' }),
      expected: false,
    });
  });
});
