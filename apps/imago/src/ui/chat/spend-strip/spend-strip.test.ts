import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { CREDITS, creditsLabel, spendSourceOf } from './spend-strip-model';

describe('spendSourceOf() (IMC-2.4)', () => {
  test('personal credits', () => {
    assert({
      given: "apps/web's credit balance with billing on",
      should: 'spend from Your credits, with the funded balance left',
      actual: spendSourceOf({ billingEnabled: true, spendable: 612, monthly: { remaining: 612 }, topup: { remaining: 0 } }),
      expected: { label: 'Your credits', left: '612 credits left' },
    });
  });

  test('billing disabled (tenant, on-prem)', () => {
    assert({
      given: 'billingEnabled false',
      should: 'show no strip',
      actual: spendSourceOf({ billingEnabled: false, spendable: 612 }),
      expected: null,
    });
  });

  test('not loaded or not a balance', () => {
    assert({
      given: 'nothing yet, and a body without a number',
      should: 'show no strip rather than a wrong amount',
      actual: [spendSourceOf(undefined), spendSourceOf({ billingEnabled: true })],
      expected: [null, null],
    });
  });

  test('the route', () => {
    assert({ given: 'the strip', should: 'read the credits route', actual: CREDITS, expected: '/api/credits' });
  });
});

describe('creditsLabel()', () => {
  test('whole numbers, never dollars or decimals', () => {
    assert({
      given: 'balances of 1120, 1482.7, 0 and -14.2',
      should: 'read as whole credits with thousands separators',
      actual: [1120, 1482.7, 0, -14.2].map(creditsLabel),
      expected: ['1,120 credits', '1,483 credits', '0 credits', '-14 credits'],
    });
  });

  test('one credit', () => {
    assert({ given: 'a balance of 1', should: 'say credit', actual: creditsLabel(1), expected: '1 credit' });
  });
});
