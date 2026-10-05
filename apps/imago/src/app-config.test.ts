import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import type { IncomingHttpHeaders } from 'node:http';
import type { NextConfig } from 'next';
import {
  getRewrittenUrl,
  unstable_getResponseFromNextConfig,
} from 'next/experimental/testing/server';
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from 'next/constants';
import nextConfig from '../next.config';
import packageJson from '../package.json';

// rewrites() may return the array form; this config only ever uses the phased object.
const phasedRewrites = async (phase: string) => {
  const rewrites = await nextConfig(phase).rewrites?.();
  return rewrites && !Array.isArray(rewrites) ? rewrites : undefined;
};

// The dev /api proxy is the only rewrite that leaves basePath.
const apiProxies = async (phase: string) =>
  (await phasedRewrites(phase))?.afterFiles?.filter((route) => route.basePath === false);

const devRewrites = () => apiProxies(PHASE_DEVELOPMENT_SERVER);

describe('apps/imago configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('next.config.ts', () => {
    assert({
      given: 'the imago Next config',
      should: 'serve the app under /imago',
      actual: nextConfig(PHASE_PRODUCTION_BUILD).basePath,
      expected: '/imago',
    });

    assert({
      given: 'the imago Next config',
      should: 'build the standalone server',
      actual: nextConfig(PHASE_PRODUCTION_BUILD).output,
      expected: 'standalone',
    });
  });

  test('dev /api proxy', async () => {
    vi.stubEnv('WEB_APP_INTERNAL_URL', 'http://127.0.0.1:3100');
    assert({
      given: 'next dev with WEB_APP_INTERNAL_URL set',
      should: 'rewrite /api/:path* outside basePath to apps/web',
      actual: await devRewrites(),
      expected: [
        {
          source: '/api/:path*',
          destination: 'http://127.0.0.1:3100/api/:path*',
          basePath: false,
        },
      ],
    });

    vi.stubEnv('WEB_APP_INTERNAL_URL', 'http://web.internal:3000/');
    assert({
      given: 'a WEB_APP_INTERNAL_URL with a trailing slash',
      should: 'proxy to its origin without a doubled slash',
      actual: (await devRewrites())?.[0]?.destination,
      expected: 'http://web.internal:3000/api/:path*',
    });

    vi.stubEnv('WEB_APP_INTERNAL_URL', '');
    assert({
      given: 'next dev without WEB_APP_INTERNAL_URL',
      should: "proxy to apps/web's default dev origin",
      actual: (await devRewrites())?.[0]?.destination,
      expected: 'http://localhost:3000/api/:path*',
    });

    vi.stubEnv('WEB_APP_INTERNAL_URL', 'not a url');
    const error = await devRewrites().then(
      () => undefined,
      (e: unknown) => e,
    );
    assert({
      given: 'a WEB_APP_INTERNAL_URL that is not a URL',
      should: 'fail loudly naming the variable',
      actual: error instanceof Error && error.message.includes('WEB_APP_INTERNAL_URL'),
      expected: true,
    });
  });

  test('no proxy outside next dev', async () => {
    vi.stubEnv('WEB_APP_INTERNAL_URL', 'http://127.0.0.1:3100');

    assert({
      given: 'next build',
      should: 'bake no /api proxy into the production routes manifest',
      actual: await apiProxies(PHASE_PRODUCTION_BUILD),
      expected: [],
    });

    assert({
      given: 'next start',
      should: 'not proxy /api (production routes /api at the edge)',
      actual: await apiProxies(PHASE_PRODUCTION_SERVER),
      expected: [],
    });

    const destinations = (
      await Promise.all(
        [PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER].map(async (phase) => {
          const phased = await phasedRewrites(phase);
          return [
            ...(phased?.beforeFiles ?? []),
            ...(phased?.afterFiles ?? []),
            ...(phased?.fallback ?? []),
          ].map((route) => route.destination);
        }),
      )
    ).flat();
    assert({
      given: 'a production build or server',
      should: 'rewrite only to imago itself, never to apps/web',
      actual: destinations.every((destination) => destination.startsWith('/')),
      expected: true,
    });
  });

  test('package.json', () => {
    assert({
      given: 'the imago dev script',
      should: 'run next dev on port 3006',
      actual: packageJson.scripts.dev,
      expected: 'next dev --port 3006 --hostname 0.0.0.0',
    });

    assert({
      given: 'the imago workspace',
      should: 'pin Next to the version apps/web runs',
      actual: packageJson.dependencies.next,
      expected: '15.5.18',
    });
  });
});
// Next renders a document request carrying next-router-prefetch: 1 as a router
// prefetch, and that render throws on the server (500). The header is hidden
// from middleware and from headers(), so next.config routes such a request to
// a 404 before it reaches the render. Real router prefetches send RSC: 1.
describe('apps/imago prefetch-headed document rewrite', () => {
  // What `next start` serves.
  const serverConfig = nextConfig(PHASE_PRODUCTION_SERVER);

  const rewriteOf = async (
    pathname: string,
    headers: IncomingHttpHeaders = {},
    config: NextConfig = serverConfig,
  ): Promise<string | null> => {
    const response = await unstable_getResponseFromNextConfig({
      url: `http://localhost:3006${pathname}`,
      nextConfig: config,
      headers,
    });
    const rewritten = getRewrittenUrl(response);
    return rewritten === null ? null : new URL(rewritten).pathname;
  };

  const PAGES = ['/imago', '/imago/drive-1', '/imago/drive-1/files', '/imago/apix'];
  const DESTINATION = '/imago/api/prefetch-document';

  test('a document request carrying next-router-prefetch: 1', async () => {
    assert({
      given: 'a page path requested without RSC but with next-router-prefetch: 1',
      should: 'answer from the 404 route instead of rendering',
      actual: await Promise.all(
        PAGES.map((pathname) => rewriteOf(pathname, { 'next-router-prefetch': '1' })),
      ),
      expected: PAGES.map(() => DESTINATION),
    });

    const response = await unstable_getResponseFromNextConfig({
      url: 'http://localhost:3006/imago/api/nope',
      nextConfig: serverConfig,
      headers: { 'next-router-prefetch': '1' },
    });
    assert({
      given: 'an API path no route handler serves, with next-router-prefetch: 1',
      should: 'fall back to the 404 route instead of rendering the not-found page',
      actual: getRewrittenUrl(response),
      expected: `http://localhost:3006${DESTINATION}`,
    });

    assert({
      given: 'a malformed RSC header alongside next-router-prefetch: 1',
      should: 'still answer from the 404 route (Next only honours RSC: 1)',
      actual: await rewriteOf('/imago/drive-1', { rsc: '2', 'next-router-prefetch': '1' }),
      expected: DESTINATION,
    });
  });

  // The helper applies every rewrite phase at once; in Next a fallback rewrite
  // only runs when no route handler matched. So the API space is checked
  // against the phases that run before route handlers.
  test('API routes', async () => {
    const phasesOf = async () => {
      const rewrites = await serverConfig.rewrites?.();
      return rewrites && !Array.isArray(rewrites) ? rewrites : null;
    };
    // Fresh routes per call: Next prefixes basePath onto the objects it loads.
    const beforeHandlers: NextConfig = {
      ...serverConfig,
      rewrites: async () => {
        const phased = await phasesOf();
        return {
          beforeFiles: phased?.beforeFiles ?? [],
          afterFiles: phased?.afterFiles ?? [],
          fallback: [],
        };
      },
    };
    const API_PATHS = ['/imago/api', '/imago/api/health', '/imago/api/a/b'];

    assert({
      given: 'an API path with next-router-prefetch: 1',
      should: 'reach its route handler (health stays up) before any rewrite',
      actual: await Promise.all(
        API_PATHS.map((pathname) =>
          rewriteOf(pathname, { 'next-router-prefetch': '1' }, beforeHandlers),
        ),
      ),
      expected: API_PATHS.map(() => null),
    });

    assert({
      given: 'the API space',
      should: 'be rewritten only as a fallback',
      actual: (await phasesOf())?.fallback?.map((route) => route.source),
      expected: ['/api/:path*'],
    });
  });

  test('requests left alone', async () => {
    const untouched: [string, IncomingHttpHeaders][] = [
      ['/imago/drive-1', {}],
      ['/imago/drive-1', { rsc: '1' }],
      ['/imago/drive-1', { rsc: '1', 'next-router-prefetch': '1' }],
      ['/imago', { rsc: '1', 'next-router-prefetch': '1' }],
      ['/imago/drive-1', { 'next-router-prefetch': '2' }],
      ['/imago/drive-1', { purpose: 'prefetch' }],
      ['/imago/api/health', { rsc: '1', 'next-router-prefetch': '1' }],
      ['/imago/_next/static/chunks/main.js', { 'next-router-prefetch': '1' }],
    ];

    assert({
      given: 'a real router prefetch, a plain request or a static chunk',
      should: 'not be rewritten',
      actual: await Promise.all(untouched.map(([pathname, headers]) => rewriteOf(pathname, headers))),
      expected: untouched.map(() => null),
    });
  });
});
