import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { grantDateLabel, nextGrantOf } from './next-grant';

/** A /api/credits body (cents of credit value, 10 to the credit); spendable nets debt, as the server sends it. */
type Fixture = { remaining?: number; topup?: number; debt?: number; allowance?: number; periodEnd?: string | null; tier?: string; spendable?: number };

const balance = ({ remaining = 0, topup = 0, debt = 0, allowance = 9000, periodEnd = '2026-12-03T12:00:00.000Z', tier = 'pro', spendable = remaining + topup - debt }: Fixture = {}) => ({
  subscriptionTier: tier,
  monthly: { remaining, allowance, periodEnd },
  topup: { remaining: topup },
  debt,
  spendable,
});

describe('nextGrantOf()', () => {
  test('a paid tier with no debt', () => {
    assert({
      given: 'a 900-credit allowance renewing Dec 3, with credits carried and top-ups held',
      should: 'promise the whole allowance on that date (rollover adds it on top)',
      actual: [nextGrantOf(balance()), nextGrantOf(balance({ remaining: 6120, topup: 10000 }))],
      expected: [{ cents: 9000, on: 'Dec 3' }, { cents: 9000, on: 'Dec 3' }],
    });
  });

  test('debt is paid out of the next allowance first', () => {
    assert({
      given: 'a 250-credit debt, nothing carried, against a 900-credit allowance (computeMonthlyRefill nets it)',
      should: 'promise only the 650 credits the balance will actually gain',
      actual: nextGrantOf(balance({ debt: 2500 })),
      expected: { cents: 6500, on: 'Dec 3' },
    });
  });

  test('debt with a top-up present', () => {
    assert({
      given: 'a 100-credit debt already netted from 300 top-up credits (spendable 200), nothing carried, a 900 allowance',
      should: 'promise 900: the debt is counted once, not again against the allowance',
      actual: nextGrantOf(balance({ topup: 3000, debt: 1000 })),
      expected: { cents: 9000, on: 'Dec 3' },
    });
  });

  test('debt partly covered by the carried monthly balance', () => {
    assert({
      given: '40 credits carried, a 100-credit debt and a 900 allowance (spendable -60)',
      should: 'promise the 840 the balance goes up by (from -60, shown as 0, to 840)',
      actual: nextGrantOf(balance({ remaining: 400, debt: 1000 })),
      expected: { cents: 8400, on: 'Dec 3' },
    });
  });

  test('debt that swallows the whole allowance', () => {
    assert({
      given: 'a debt at or above the allowance',
      should: 'promise nothing rather than "0 more"',
      actual: [nextGrantOf(balance({ debt: 9000 })), nextGrantOf(balance({ debt: 12000 }))],
      expected: [null, null],
    });
  });

  test('no grant to promise', () => {
    assert({
      given: 'a free tier (a one-time grant), no allowance, a bad or missing period end, a balance missing its buckets, and no balance',
      should: 'promise nothing',
      actual: [
        nextGrantOf(balance({ tier: 'free' })),
        nextGrantOf(balance({ allowance: 0 })),
        nextGrantOf(balance({ periodEnd: 'soon' })),
        nextGrantOf(balance({ periodEnd: null })),
        nextGrantOf({ subscriptionTier: 'pro', monthly: { allowance: 9000, periodEnd: '2026-12-03T12:00:00.000Z' } }),
        nextGrantOf(undefined),
      ],
      expected: [null, null, null, null, null, null],
    });
  });

  test('less than a credit gained', () => {
    assert({
      given: 'debt leaving 4 cents of the allowance (rounds to 0 credits)',
      should: 'promise nothing rather than "0 more"',
      actual: nextGrantOf(balance({ debt: 8996 })),
      expected: null,
    });
  });
});

describe('grantDateLabel()', () => {
  test('a short UTC date', () => {
    assert({
      given: 'period-end timestamps, a bad string and null',
      should: 'write "Mon D" in UTC, as the server rolls periods, or null',
      actual: [grantDateLabel('2026-11-03T12:00:00.000Z'), grantDateLabel('2026-12-03T23:30:00.000Z'), grantDateLabel('not a date'), grantDateLabel(null)],
      expected: ['Nov 3', 'Dec 3', null, null],
    });
  });
});
