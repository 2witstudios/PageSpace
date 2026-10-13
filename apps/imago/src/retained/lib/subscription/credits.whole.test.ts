import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { formatWholeCredits, includedCreditsPhrase, topUpRatePhrase } from './credits';

describe('whole-credit account copy', () => {
  test('formatWholeCredits rounds to whole credits with thousands separators', () => {
    assert({
      given: 'cents for 1,000 credits, 15 credits and 4.7 credits',
      should: 'render whole credits with no decimals',
      actual: [formatWholeCredits(100000), formatWholeCredits(1500), formatWholeCredits(470)],
      expected: ['1,000', '15', '5'],
    });
  });

  test('includedCreditsPhrase words a refilling tier and the free starter grant differently', () => {
    assert({
      given: 'a refilling Pro allowance and the free one-time grant',
      should: 'say included each month for Pro and to start for Free',
      actual: [includedCreditsPhrase('pro', 1500), includedCreditsPhrase('free', 500)],
      expected: ['15 credits included each month', '5 credits to start'],
    });
  });

  test('topUpRatePhrase quotes the smallest pack in whole credits and dollars', () => {
    assert({
      given: 'the canonical credit packs',
      should: 'quote the smallest pack as credits per dollars',
      actual: topUpRatePhrase(),
      expected: '10 credits per $10',
    });
  });
});
