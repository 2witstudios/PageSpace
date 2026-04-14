/**
 * PageSpace service worker routing classifier.
 *
 * Pure decision function extracted from sw.js so it can be unit-tested
 * without faking FetchEvent. Consumed two ways:
 *   - In the service worker via importScripts('/sw-router.js'), which
 *     attaches classifyRequest to `self`.
 *   - In vitest via `import { classifyRequest } from '../../public/sw-router.js'`,
 *     which reads the CommonJS module.exports assignment below.
 *
 * The classifier encodes three layered invariants, in order of strength:
 *   1. The service worker must not own top-level navigations. Requests
 *      with `request.mode === 'navigate'` are the browser's business —
 *      OAuth callbacks, redirects to custom schemes like pagespace://,
 *      and normal page loads must remain browser-owned so native scheme
 *      dispatch and redirect following work correctly.
 *   2. Service workers must not sit in the credential-exchange redirect
 *      path. Auth routes redirect to custom schemes; rule 1 keeps them
 *      browser-owned mechanically rather than via a path allowlist.
 *   3. "API" to the SW means XHR/fetch from the running SPA, not a
 *      top-level navigation. Encoded via request mode, not path prefix.
 */

/**
 * @typedef {(
 *   | 'not-intercepted'
 *   | 'native-pass-through'
 *   | 'api-network-first'
 *   | 'cache-first'
 *   | 'network-first'
 * )} RouteClassification
 */

/**
 * @param {string} pathname
 * @returns {boolean}
 */
function isStaticAssetPath(pathname) {
  const staticExtensions = [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.svg',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
  ];
  return staticExtensions.some((ext) => pathname.endsWith(ext));
}

/**
 * @param {{ mode: string, method: string, url: string }} input
 * @returns {RouteClassification}
 */
function classifyRequest(input) {
  const { mode, method, url } = input;

  if (method !== 'GET') return 'not-intercepted';

  // Rule 1 enforcement: top-level navigations bypass the SW entirely.
  // A path-based allowlist would silently break future non-auth
  // navigations under /api/; mode is the semantic boundary.
  if (mode === 'navigate') return 'native-pass-through';

  // Base is only consulted by unit tests that pass relative-ish URLs;
  // production SW callers always pass absolute same-origin URLs.
  const parsed = new URL(url, 'http://localhost');

  // Next.js runtime chunks: let the browser fetch directly to avoid
  // stale bundle mismatches after deploys.
  if (parsed.pathname.startsWith('/_next/')) return 'native-pass-through';

  // Rule 3: any remaining /api/ request is an in-app XHR, safe for
  // network-first-with-cache. Navigations were peeled off above.
  if (parsed.pathname.startsWith('/api/')) return 'api-network-first';

  if (isStaticAssetPath(parsed.pathname)) return 'cache-first';

  // Next.js RSC/prefetch headers are handled inside sw.js's
  // network-first branch, not here — the classifier is header-agnostic.
  return 'network-first';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classifyRequest, isStaticAssetPath };
}
if (typeof self !== 'undefined') {
  self.classifyRequest = classifyRequest;
}
