import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from 'next/constants';
import nextConfig from '../next.config';
import packageJson from '../package.json';

// rewrites() may return the phased object form; this config only ever uses the array.
const devRewrites = async () => {
  const rewrites = await nextConfig(PHASE_DEVELOPMENT_SERVER).rewrites?.();
  return Array.isArray(rewrites) ? rewrites : undefined;
};

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

  test('no proxy outside next dev', () => {
    vi.stubEnv('WEB_APP_INTERNAL_URL', 'http://127.0.0.1:3100');

    assert({
      given: 'next build',
      should: 'bake no /api rewrite into the production routes manifest',
      actual: nextConfig(PHASE_PRODUCTION_BUILD).rewrites,
      expected: undefined,
    });

    assert({
      given: 'next start',
      should: 'not proxy /api (production routes /api at the edge)',
      actual: nextConfig(PHASE_PRODUCTION_SERVER).rewrites,
      expected: undefined,
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
