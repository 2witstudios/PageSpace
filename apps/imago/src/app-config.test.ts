import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import nextConfig from '../next.config';
import packageJson from '../package.json';

describe('apps/imago configuration', () => {
  test('next.config.ts', () => {
    assert({
      given: 'the imago Next config',
      should: 'serve the app under /imago',
      actual: nextConfig.basePath,
      expected: '/imago',
    });

    assert({
      given: 'the imago Next config',
      should: 'build the standalone server',
      actual: nextConfig.output,
      expected: 'standalone',
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
