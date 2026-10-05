import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import nextConfig from '../next.config';
import { config, middleware } from './middleware';
import { NONCE_HEADER, buildAPICSPPolicy, buildCSPPolicy } from './middleware/security-headers';

const imagoRequest = (pathname: string): NextRequest =>
  new NextRequest(`http://localhost:3006${pathname}`, {
    nextConfig: { basePath: '/imago' },
  });

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
