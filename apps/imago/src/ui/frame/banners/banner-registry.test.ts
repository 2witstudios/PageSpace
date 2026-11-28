import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { pickBanner, type Banner } from './banner-registry';

const banner = (id: string, priority: number): Banner => ({ id, priority, tone: 'info', message: id });

describe('pickBanner()', () => {
  test('the highest priority banner present', () => {
    const offline = banner('offline', 90);
    const verify = banner('verify', 60);
    assert({
      given: 'a verify-email banner and an offline banner, with a missing candidate',
      should: 'show the offline banner, the higher priority',
      actual: pickBanner([verify, null, offline])?.id,
      expected: 'offline',
    });
  });

  test('null when no banner applies', () => {
    assert({
      given: 'no candidates that apply',
      should: 'show nothing',
      actual: pickBanner([null, null]),
      expected: null,
    });
  });

  test('the earlier candidate on a tie', () => {
    assert({
      given: 'two banners with the same priority',
      should: 'show the one listed first',
      actual: pickBanner([banner('first', 50), banner('second', 50)])?.id,
      expected: 'first',
    });
  });
});
