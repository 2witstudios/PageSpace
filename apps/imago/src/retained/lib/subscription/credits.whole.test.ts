import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { formatWholeCredits, includedCreditsPhraseForCents, topUpRatePhrase } from './credits';

describe('whole-credit account copy', () => {
  test('formatWholeCredits rounds to whole credits with thousands separators', () => {
    assert({
      given: 'whole and fractional credit values represented in internal cents',
      should: 'render whole credits with no decimals',
      actual: [formatWholeCredits(1000), formatWholeCredits(15), formatWholeCredits(4.7)],
      expected: ['1,000', '15', '5'],
    });
  });

  test('includedCreditsPhrase words a refilling tier and the free starter grant differently', () => {
    assert({
      given: 'a refilling Pro allowance and the free one-time grant',
      should: 'say included each month for Pro and to start for Free',
      actual: [includedCreditsPhraseForCents('pro', 1500), includedCreditsPhraseForCents('free', 500)],
      expected: ['1,500 credits included each month', '500 credits to start'],
    });
  });

  test('topUpRatePhrase quotes the smallest pack in whole credits and dollars', () => {
    assert({
      given: 'the canonical credit packs',
      should: 'quote the smallest pack as credits per dollars',
      actual: topUpRatePhrase(),
      expected: '1,000 credits per $10',
    });
  });
});
