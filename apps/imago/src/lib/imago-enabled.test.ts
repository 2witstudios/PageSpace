import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { isImagoEnabled } from './imago-enabled';

describe('isImagoEnabled()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('only the exact value true', () => {
    const cases: Array<[string | undefined, boolean]> = [
      [undefined, false],
      ['', false],
      ['false', false],
      ['TRUE', false],
      ['1', false],
      [' true', false],
      ['true', true],
    ];

    for (const [flag, expected] of cases) {
      vi.stubEnv('IMAGO_ENABLED', flag);
      assert({
        given: `IMAGO_ENABLED=${JSON.stringify(flag)}`,
        should: expected ? 'be on' : 'be off',
        actual: isImagoEnabled(),
        expected,
      });
    }
  });
});
