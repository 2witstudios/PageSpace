import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
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

// The suites below are about a deployment with imago switched on; the flag
// itself is covered by 'middleware() IMAGO_ENABLED gate'.
const enableImago = (): void => {
  beforeEach(() => {
    vi.stubEnv('IMAGO_ENABLED', 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
};

describe('middleware()', () => {
  enableImago();

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
  enableImago();

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

  test('next dev', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_WEB_APP_URL', 'http://localhost:3000');
    const { location } = redirectOf(
      middleware(imagoRequest('/imago/drive-1/files', { session: null })),
    );

    assert({
      given: 'next dev, where only /api is proxied to apps/web',
      should: "send it to apps/web's origin, which serves the sign-in page",
      actual: location?.origin,
      expected: 'http://localhost:3000',
    });

    assert({
      given: 'next dev',
      should: 'still carry the requested imago path as next=',
      actual: location?.searchParams.get('next'),
      expected: '/imago/drive-1/files',
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

describe('middleware() IMAGO_ENABLED gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const ROUTES = ['/imago', '/imago/drive-1/files', '/imago/api/anything', '/imago/api/healthz'];

  const statusesWith = (flag: string | undefined, session: string | null): number[] => {
    vi.stubEnv('IMAGO_ENABLED', flag);
    return ROUTES.map((pathname) => middleware(imagoRequest(pathname, { session })).status);
  };

  test('flag unset', () => {
    assert({
      given: 'IMAGO_ENABLED unset and a signed-in request',
      should: 'answer 404 for every imago route',
      actual: statusesWith(undefined, 'ps_sess_test'),
      expected: [404, 404, 404, 404],
    });

    assert({
      given: 'IMAGO_ENABLED unset and no session cookie',
      should: 'answer 404 instead of sending the visitor to sign-in',
      actual: statusesWith(undefined, null),
      expected: [404, 404, 404, 404],
    });
  });

  test('flag set to anything but true', () => {
    for (const flag of ['false', '', 'TRUE', '1', ' true', 'yes']) {
      assert({
        given: `IMAGO_ENABLED=${JSON.stringify(flag)}`,
        should: 'answer 404 for every imago route',
        actual: statusesWith(flag, 'ps_sess_test'),
        expected: [404, 404, 404, 404],
      });
    }
  });

  test('the 404 response', () => {
    vi.stubEnv('IMAGO_ENABLED', 'false');
    const response = middleware(imagoRequest('/imago/drive-1'));

    assert({
      given: 'imago switched off',
      should: 'not be cached, so flipping the flag takes effect at once',
      actual: response.headers.get('Cache-Control'),
      expected: 'no-store',
    });

    assert({
      given: 'imago switched off',
      should: 'not forward the request to the render',
      actual: response.headers.get('x-middleware-next'),
      expected: null,
    });
  });

  test('health stays up', () => {
    for (const flag of [undefined, 'false', 'true']) {
      vi.stubEnv('IMAGO_ENABLED', flag);
      const response = middleware(imagoRequest('/imago/api/health', { session: null }));

      assert({
        given: `IMAGO_ENABLED=${JSON.stringify(flag)} and the health route`,
        should: 'pass through with the API CSP',
        actual: [response.status, response.headers.get('Content-Security-Policy')],
        expected: [200, buildAPICSPPolicy()],
      });
    }
  });

  test('flag true', () => {
    assert({
      given: "IMAGO_ENABLED='true' and a signed-in request",
      should: 'pass every route through',
      actual: statusesWith('true', 'ps_sess_test'),
      expected: [200, 200, 200, 200],
    });
  });

  test('read at request time', () => {
    vi.stubEnv('IMAGO_ENABLED', 'false');
    const off = middleware(imagoRequest('/imago/drive-1')).status;
    vi.stubEnv('IMAGO_ENABLED', 'true');
    const on = middleware(imagoRequest('/imago/drive-1')).status;
    vi.stubEnv('IMAGO_ENABLED', 'false');
    const offAgain = middleware(imagoRequest('/imago/drive-1')).status;

    assert({
      given: 'the flag changing between requests in one process',
      should: 'follow the value at each request',
      actual: [off, on, offAgain],
      expected: [404, 200, 404],
    });
  });

  test('deployment mode does not matter', () => {
    for (const mode of ['cloud', 'tenant', 'onprem']) {
      vi.stubEnv('DEPLOYMENT_MODE', mode);
      vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_MODE', mode);

      assert({
        given: `DEPLOYMENT_MODE=${mode} with the flag unset, then true`,
        should: 'gate on the flag alone',
        actual: [statusesWith(undefined, 'ps_sess_test'), statusesWith('true', 'ps_sess_test')],
        expected: [
          [404, 404, 404, 404],
          [200, 200, 200, 200],
        ],
      });
    }
  });
});

describe('middleware config.matcher', () => {
  const matches = (url: string, headers: Record<string, string> = {}): boolean =>
    unstable_doesMiddlewareMatch({
      config,
      nextConfig: nextConfig(PHASE_DEVELOPMENT_SERVER),
      url,
      headers,
    });

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
      given: 'a router prefetch (RSC with the prefetch header)',
      should: 'skip middleware',
      actual: matches('/imago/drive-1', { rsc: '1', 'next-router-prefetch': '1' }),
      expected: false,
    });

    assert({
      given: 'a router prefetch of the imago root',
      should: 'skip middleware',
      actual: matches('/imago', { rsc: '1', 'next-router-prefetch': '1' }),
      expected: false,
    });

    assert({
      given: 'a dev /api call proxied to apps/web',
      should: 'skip middleware so apps/web answers with its own headers',
      actual: matches('/api/auth/csrf'),
      expected: false,
    });
  });

  // The prefetch headers are client-settable, so only a request shaped like a
  // real router prefetch may skip the gates; everything else runs middleware.
  const PREFETCH_HEADERS: Record<string, string>[] = [
    { 'next-router-prefetch': '1' },
    { 'next-router-prefetch': '2' },
    { purpose: 'prefetch' },
    { rsc: '1', 'next-router-prefetch': '1' },
    { rsc: '1', purpose: 'prefetch' },
    { rsc: '1', 'next-router-prefetch': '1', purpose: 'prefetch' },
  ];

  test('API routes with a prefetch header', () => {
    for (const pathname of ['/imago/api/health', '/imago/api/anything', '/imago/api/a/b']) {
      assert({
        given: `${pathname} with each client-settable prefetch header`,
        should: 'still run middleware (flag gate and auth gate)',
        actual: PREFETCH_HEADERS.map((headers) => matches(pathname, headers)),
        expected: PREFETCH_HEADERS.map(() => true),
      });
    }
  });

  test('page documents with a prefetch header', () => {
    for (const pathname of ['/imago', '/imago/drive-1/files']) {
      assert({
        given: `a non-RSC request for ${pathname} carrying a prefetch header`,
        should: 'still run middleware: it is a document, not a router prefetch',
        actual: [
          matches(pathname, { 'next-router-prefetch': '1' }),
          matches(pathname, { purpose: 'prefetch' }),
          matches(pathname, { rsc: '2', 'next-router-prefetch': '1' }),
        ],
        expected: [true, true, true],
      });
    }

    assert({
      given: 'an RSC navigation (no prefetch header)',
      should: 'run middleware',
      actual: matches('/imago/drive-1', { rsc: '1' }),
      expected: true,
    });

    assert({
      given: 'an RSC request with next-router-prefetch other than 1 (a runtime prefetch renders the page)',
      should: 'run middleware: only the exact router prefetch value may skip it',
      actual: [
        matches('/imago', { rsc: '1', 'next-router-prefetch': '2' }),
        matches('/imago/drive-1', { rsc: '1', 'next-router-prefetch': '2' }),
        matches('/imago/drive-1', { rsc: '1', 'next-router-prefetch': '' }),
      ],
      expected: [true, true, true],
    });

    assert({
      given: 'an RSC request with only purpose: prefetch',
      should: 'run middleware (the router never sends it)',
      actual: matches('/imago/drive-1', { rsc: '1', purpose: 'prefetch' }),
      expected: true,
    });
  });
});
