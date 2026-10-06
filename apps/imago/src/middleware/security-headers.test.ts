import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { NextRequest } from 'next/server';
import {
  NONCE_HEADER,
  buildAPICSPPolicy,
  buildCSPPolicy,
  createSecureResponse,
  generateNonce,
} from './security-headers';

const directive = (policy: string, name: string): string | undefined =>
  policy
    .split('; ')
    .find((entry) => entry.startsWith(`${name} `));

describe('generateNonce()', () => {
  test('per-request nonce', () => {
    assert({
      given: 'two calls',
      should: 'return different nonces',
      actual: generateNonce() === generateNonce(),
      expected: false,
    });

    assert({
      given: 'a nonce',
      should: 'be base64',
      actual: /^[A-Za-z0-9+/]+=*$/.test(generateNonce()),
      expected: true,
    });
  });
});

describe('buildCSPPolicy()', () => {
  test('document policy', () => {
    const policy = buildCSPPolicy('abc123');

    assert({
      given: 'a nonce',
      should: 'allow only nonce-bearing scripts and what they load',
      actual: directive(policy, 'script-src'),
      expected: "script-src 'self' 'nonce-abc123' 'strict-dynamic' 'unsafe-inline'",
    });

    assert({
      given: 'a nonce',
      should: 'forbid framing the app',
      actual: directive(policy, 'frame-ancestors'),
      expected: "frame-ancestors 'none'",
    });

    assert({
      given: 'a nonce',
      should: 'block plugins',
      actual: directive(policy, 'object-src'),
      expected: "object-src 'none'",
    });
  });
});

describe('buildCSPPolicy() by mode', () => {
  test('next dev', () => {
    const policy = buildCSPPolicy('abc123', { isDevelopment: true });

    assert({
      given: 'the development server',
      should: "add 'unsafe-eval' so React's dev build can rebuild stacks and hydrate",
      actual: directive(policy, 'script-src'),
      expected:
        "script-src 'self' 'nonce-abc123' 'strict-dynamic' 'unsafe-inline' 'unsafe-eval'",
    });
  });

  test('production', () => {
    for (const options of [undefined, { isDevelopment: false }]) {
      assert({
        given: `a production policy (${JSON.stringify(options)})`,
        should: "keep script-src strict, with no 'unsafe-eval'",
        actual: directive(buildCSPPolicy('abc123', options), 'script-src'),
        expected: "script-src 'self' 'nonce-abc123' 'strict-dynamic' 'unsafe-inline'",
      });
    }
  });

  test('only script-src changes', () => {
    const strip = (policy: string): string =>
      policy
        .split('; ')
        .filter((entry) => !entry.startsWith('script-src '))
        .join('; ');

    assert({
      given: 'the development server',
      should: 'leave every other directive as in production',
      actual: strip(buildCSPPolicy('abc123', { isDevelopment: true })),
      expected: strip(buildCSPPolicy('abc123')),
    });
  });
});

// Docker Compose serves realtime on its own origin (:3001). socket.io opens
// with HTTP long-polling, which ws:/wss: do not cover, so the configured
// realtime origin has to be in connect-src or the socket never connects.
describe('buildCSPPolicy() realtime origin', () => {
  test('a cross-origin realtime server', () => {
    assert({
      given: 'NEXT_PUBLIC_REALTIME_URL on another origin',
      should: "allow that origin in connect-src for socket.io's polling",
      actual: directive(buildCSPPolicy('abc123', { realtimeUrl: 'http://localhost:3001' }), 'connect-src'),
      expected: "connect-src 'self' ws: wss: http://localhost:3001",
    });

    assert({
      given: 'a realtime URL with a path or trailing slash',
      should: 'allow only its origin',
      actual: directive(buildCSPPolicy('abc123', { realtimeUrl: 'https://rt.example.com/socket/' }), 'connect-src'),
      expected: "connect-src 'self' ws: wss: https://rt.example.com",
    });
  });

  test('no realtime origin to add', () => {
    for (const realtimeUrl of [undefined, '', 'not a url', 'javascript:alert(1)', 'data:text/plain,x', "https://x.test'; script-src *"]) {
      assert({
        given: `realtimeUrl ${JSON.stringify(realtimeUrl)}`,
        should: "keep connect-src at 'self' ws: wss:",
        actual: directive(buildCSPPolicy('abc123', { realtimeUrl }), 'connect-src'),
        expected: "connect-src 'self' ws: wss:",
      });
    }
  });

  test('only connect-src changes', () => {
    const strip = (policy: string): string =>
      policy
        .split('; ')
        .filter((entry) => !entry.startsWith('connect-src '))
        .join('; ');

    assert({
      given: 'a realtime origin',
      should: 'leave every other directive as without one',
      actual: strip(buildCSPPolicy('abc123', { realtimeUrl: 'http://localhost:3001' })),
      expected: strip(buildCSPPolicy('abc123')),
    });
  });

  test('createSecureResponse()', () => {
    const request = new NextRequest('http://localhost:3006/imago');
    const { response, nonce } = createSecureResponse(true, request, { realtimeUrl: 'http://localhost:3001' });
    const policy = buildCSPPolicy(nonce, { realtimeUrl: 'http://localhost:3001' });

    assert({
      given: 'a document request with a realtime URL',
      should: 'enforce the policy that allows it in the browser',
      actual: response.headers.get('Content-Security-Policy'),
      expected: policy,
    });

    assert({
      given: 'a document request with a realtime URL',
      should: 'forward the same policy to the render',
      actual: response.headers.get('x-middleware-request-content-security-policy'),
      expected: policy,
    });
  });
});

describe('buildAPICSPPolicy()', () => {
  test('API policy', () => {
    assert({
      given: 'an API response',
      should: 'deny every resource',
      actual: buildAPICSPPolicy(),
      expected: "default-src 'none'; frame-ancestors 'none'",
    });
  });
});

describe('createSecureResponse()', () => {
  test('document request', () => {
    const request = new NextRequest('http://localhost:3006/imago');
    const { response, nonce } = createSecureResponse(false, request);

    assert({
      given: 'a document request',
      should: 'forward the nonce to the render on the request headers',
      actual: response.headers.get(`x-middleware-request-${NONCE_HEADER}`),
      expected: nonce,
    });

    assert({
      given: 'a document request',
      should: 'forward the CSP to the render so Next stamps the nonce on its scripts',
      actual: response.headers.get('x-middleware-request-content-security-policy'),
      expected: buildCSPPolicy(nonce),
    });

    assert({
      given: 'a document request',
      should: 'enforce the nonce CSP in the browser',
      actual: response.headers.get('Content-Security-Policy'),
      expected: buildCSPPolicy(nonce),
    });

    assert({
      given: 'a document request',
      should: 'deny framing',
      actual: response.headers.get('X-Frame-Options'),
      expected: 'DENY',
    });

    assert({
      given: 'an http request outside production',
      should: 'not emit HSTS',
      actual: response.headers.get('Strict-Transport-Security'),
      expected: null,
    });
  });

  test('development document request', () => {
    const request = new NextRequest('http://localhost:3006/imago');
    const { response, nonce } = createSecureResponse(false, request, { isDevelopment: true });
    const devPolicy = buildCSPPolicy(nonce, { isDevelopment: true });

    assert({
      given: 'a document request on the development server',
      should: "enforce the CSP with 'unsafe-eval' in the browser",
      actual: response.headers.get('Content-Security-Policy'),
      expected: devPolicy,
    });

    assert({
      given: 'a document request on the development server',
      should: "carry 'unsafe-eval' in script-src",
      actual: directive(response.headers.get('Content-Security-Policy') ?? '', 'script-src')?.includes(
        "'unsafe-eval'",
      ),
      expected: true,
    });

    assert({
      given: 'a document request on the development server',
      should: 'forward the same CSP to the render, so the nonce is unchanged',
      actual: response.headers.get('x-middleware-request-content-security-policy'),
      expected: devPolicy,
    });
  });

  test('production document request', () => {
    const request = new NextRequest('https://pagespace.ai/imago');
    const { response } = createSecureResponse(true, request);

    assert({
      given: 'a production document request',
      should: "never enforce 'unsafe-eval'",
      actual: response.headers.get('Content-Security-Policy')?.includes("'unsafe-eval'"),
      expected: false,
    });

    assert({
      given: 'a production document request',
      should: "never forward 'unsafe-eval' to the render",
      actual: response.headers
        .get('x-middleware-request-content-security-policy')
        ?.includes("'unsafe-eval'"),
      expected: false,
    });
  });

  test('development API request', () => {
    const request = new NextRequest('http://localhost:3006/imago/api/health');
    const { response } = createSecureResponse(false, request, {
      isAPIRoute: true,
      isDevelopment: true,
    });

    assert({
      given: 'an API request on the development server',
      should: 'keep the deny-all API CSP',
      actual: response.headers.get('Content-Security-Policy'),
      expected: buildAPICSPPolicy(),
    });
  });

  test('API request', () => {
    const request = new NextRequest('http://localhost:3006/imago/api/health');
    const { response } = createSecureResponse(false, request, { isAPIRoute: true });

    assert({
      given: 'an API request',
      should: 'enforce the deny-all API CSP',
      actual: response.headers.get('Content-Security-Policy'),
      expected: buildAPICSPPolicy(),
    });

    assert({
      given: 'an API request',
      should: 'not forward a document CSP to the handler',
      actual: response.headers.get('x-middleware-request-content-security-policy'),
      expected: null,
    });
  });

  test('HTTPS request', () => {
    const request = new NextRequest('http://localhost:3006/imago', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    const { response } = createSecureResponse(false, request);

    assert({
      given: 'a request forwarded over HTTPS',
      should: 'emit HSTS',
      actual: response.headers.get('Strict-Transport-Security'),
      expected: 'max-age=63072000; includeSubDomains; preload',
    });
  });
});
