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
