import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { grantDateLabel, nextGrantOf } from './next-grant';

const balance = (overrides: Record<string, unknown> = {}) => ({
  subscriptionTier: 'pro',
  // Cents of credit value, as /api/credits sends them: 10 cents to the credit.
  monthly: { allowance: 9000, periodEnd: '2026-12-03T12:00:00.000Z' },
  debt: 0,
  ...overrides,
});

describe('nextGrantOf()', () => {
  test('a paid tier with no debt', () => {
    assert({
      given: 'a 900-credit allowance renewing Dec 3',
      should: 'promise the whole allowance on that date',
      actual: nextGrantOf(balance()),
      expected: { cents: 9000, on: 'Dec 3' },
    });
  });

  test('debt is paid out of the next allowance first', () => {
    assert({
      given: 'a 250-credit debt against a 900-credit allowance (computeMonthlyRefill nets it)',
      should: 'promise only the 650 credits that will actually arrive',
      actual: nextGrantOf(balance({ debt: 2500 })),
      expected: { cents: 6500, on: 'Dec 3' },
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
      given: 'a free tier (a one-time grant), no allowance, a bad or missing period end, and no balance',
      should: 'promise nothing',
      actual: [
        nextGrantOf(balance({ subscriptionTier: 'free' })),
        nextGrantOf(balance({ monthly: { allowance: 0, periodEnd: '2026-12-03T12:00:00.000Z' } })),
        nextGrantOf(balance({ monthly: { allowance: 9000, periodEnd: 'soon' } })),
        nextGrantOf(balance({ monthly: { allowance: 9000, periodEnd: null } })),
        nextGrantOf(undefined),
      ],
      expected: [null, null, null, null, null],
    });
  });

  test('less than a credit left of the allowance', () => {
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
