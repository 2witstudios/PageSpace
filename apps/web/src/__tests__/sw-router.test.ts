/**
 * Service worker routing classifier tests.
 *
 * These tests exercise the pure decision function that the SW's fetch
 * handler delegates to. They prove three layered invariants, in order of
 * strength:
 *
 *   1. The service worker must not own top-level navigations. Requests
 *      with `request.mode === 'navigate'` are the browser's business —
 *      OAuth callbacks, redirects to custom schemes, normal page loads.
 *   2. Service workers must not sit in the credential-exchange redirect
 *      path. Auth routes redirect to custom schemes; they must always
 *      remain browser-owned. Rule 1 enforces this mechanically.
 *   3. "API" to the SW means XHR/fetch from the running SPA, not a
 *      top-level navigation. Encoded via request mode, not path prefix.
 */

import { describe, test, expect } from 'vitest';
import { classifyRequest } from '../../public/sw-router.js';

describe('sw-router classifyRequest', () => {
  test('rule 1: top-level navigation to an OAuth callback is native-pass-through', () => {
    // Given a top-level navigation to /api/auth/google/callback?code=x,
    // should be classified as native-pass-through so the browser can
    // natively follow the redirect to pagespace://auth-exchange.
    expect(
      classifyRequest({
        mode: 'navigate',
        method: 'GET',
        url: 'http://localhost/api/auth/google/callback?code=x',
      })
    ).toBe('native-pass-through');
  });

  test('rule 1 generalizes beyond auth: any navigation is native-pass-through', () => {
    // Given a top-level navigation to /dashboard, should be
    // native-pass-through. The invariant is mode-based, not path-based —
    // a path-based fix would silently break future non-auth navigations
    // that happen to land on a path under /api/.
    expect(
      classifyRequest({
        mode: 'navigate',
        method: 'GET',
        url: 'http://localhost/dashboard',
      })
    ).toBe('native-pass-through');
  });

  test('rule 3: SPA XHR to /api/pages is still api-network-first', () => {
    // Given a CORS-mode GET to /api/pages/123 (an XHR from the running
    // app), should still use the api-network-first strategy — SPA data
    // fetches remain network-first with cache fallback.
    expect(
      classifyRequest({
        mode: 'cors',
        method: 'GET',
        url: 'http://localhost/api/pages/123',
      })
    ).toBe('api-network-first');
  });

  test('/_next/ requests remain native pass-through', () => {
    // Given a GET to /_next/static/chunks/main.js, should be
    // native-pass-through. Preserved behavior: SW-managed cache on
    // runtime chunks causes stale bundle mismatches after deploys.
    expect(
      classifyRequest({
        mode: 'no-cors',
        method: 'GET',
        url: 'http://localhost/_next/static/chunks/main.js',
      })
    ).toBe('native-pass-through');
  });

  test('static asset GETs are cache-first', () => {
    // Given a GET to /favicon-32x32.png, should be cache-first —
    // images, fonts, icons rarely change and are safe to serve from
    // cache before the network.
    expect(
      classifyRequest({
        mode: 'no-cors',
        method: 'GET',
        url: 'http://localhost/favicon-32x32.png',
      })
    ).toBe('cache-first');
  });

  test('other same-origin GETs fall through to network-first', () => {
    // Given a CORS-mode GET to /some-page (not /api/, not /_next/, not a
    // static asset), should be network-first so the SW still provides an
    // offline cache for pages and dynamic assets.
    expect(
      classifyRequest({
        mode: 'cors',
        method: 'GET',
        url: 'http://localhost/some-page',
      })
    ).toBe('network-first');
  });

  test('non-GET is never intercepted', () => {
    // Given a POST to /api/auth/passkey/authenticate, should be
    // not-intercepted. The fetch handler itself skips non-GET before
    // reaching the classifier; we encode the rule here so the full
    // decision surface is testable and future code can trust it.
    expect(
      classifyRequest({
        mode: 'cors',
        method: 'POST',
        url: 'http://localhost/api/auth/passkey/authenticate',
      })
    ).toBe('not-intercepted');
  });
});
