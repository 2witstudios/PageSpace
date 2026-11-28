import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { countOf, creditsCardOf } from './avatar-menu-model';

const balance = (overrides: Record<string, unknown> = {}) => ({
  billingEnabled: true,
  subscriptionTier: 'pro',
  // /api/credits sends cents of credit value: 10 cents to the credit.
  monthly: { remaining: 6120, allowance: 9000, periodEnd: '2026-11-03T12:00:00.000Z' },
  topup: { remaining: 10000 },
  debt: 0,
  spendable: 16120,
  reserved: 140,
  ...overrides,
});

describe('creditsCardOf()', () => {
  test('the total, the plan and the next grant from /api/credits', () => {
    assert({
      given: 'a paid balance of 1,612 spendable credits (612 carried monthly, 1,000 top-up) on a 900 allowance',
      should: 'show every spendable credit as one total, and 900 more arriving on the period end',
      actual: creditsCardOf(balance()),
      expected: { plan: 'Pro', total: 1612, nextGrant: { amount: 900, on: 'Nov 3' } },
    });
  });

  test('credits roll over, so the total can pass the allowance', () => {
    assert({
      given: 'a carried balance above one month’s allowance',
      should: 'show the whole balance, never capped at the allowance',
      actual: creditsCardOf(balance({ spendable: 18000, topup: { remaining: 0 }, monthly: { remaining: 18000, allowance: 9000, periodEnd: '2026-12-03T00:00:00.000Z' } })),
      expected: { plan: 'Pro', total: 1800, nextGrant: { amount: 900, on: 'Dec 3' } },
    });
  });

  test('no card when billing is off or the balance is not loaded', () => {
    assert({
      given: 'billing disabled (tenant or on-prem), a balance missing its fields, and nothing loaded yet',
      should: 'show no card',
      actual: [creditsCardOf(balance({ billingEnabled: false })), creditsCardOf({ billingEnabled: true }), creditsCardOf(undefined)],
      expected: [null, null, null],
    });
  });

  test('a one-time grant with no period end', () => {
    assert({
      given: 'a free balance with no period end',
      should: 'promise no next grant',
      actual: creditsCardOf(balance({ subscriptionTier: 'free', spendable: 400, topup: { remaining: 0 }, monthly: { remaining: 400, allowance: 1000, periodEnd: null } })),
      expected: { plan: 'Free', total: 40, nextGrant: null },
    });
  });

  test('no allowance or an unreadable period end', () => {
    assert({
      given: 'a zero allowance with a date, then an allowance with a bad date',
      should: 'promise no next grant either way',
      actual: [
        creditsCardOf(balance({ monthly: { remaining: 0, allowance: 0, periodEnd: '2026-11-03T12:00:00.000Z' } }))?.nextGrant,
        creditsCardOf(balance({ monthly: { remaining: 0, allowance: 9000, periodEnd: 'soon' } }))?.nextGrant,
      ],
      expected: [null, null],
    });
  });

  test('a balance in debt', () => {
    assert({
      given: 'a 250-credit debt (spendable below zero) on a 900 allowance',
      should: 'show 0 credits, and only the 650 the next refill adds once the debt is paid from it',
      actual: creditsCardOf(balance({ spendable: -2500, topup: { remaining: 0 }, monthly: { remaining: 0, allowance: 9000, periodEnd: '2026-11-03T12:00:00.000Z' }, debt: 2500 })),
      expected: { plan: 'Pro', total: 0, nextGrant: { amount: 650, on: 'Nov 3' } },
    });
  });

  test('a free tier with a period end', () => {
    assert({
      given: 'a free balance that still carries a period end',
      should: 'promise no next grant, as the Usage page does (a one-time grant never renews)',
      actual: creditsCardOf(balance({ subscriptionTier: 'free' }))?.nextGrant,
      expected: null,
    });
  });

  test('a balance that is not a whole number of credits', () => {
    assert({
      given: 'cents that leave a fraction of a credit',
      should: 'round the total and the grant to whole credits',
      actual: creditsCardOf(balance({ spendable: 16126.4, monthly: { remaining: 6126.4, allowance: 9004, periodEnd: '2026-11-03T12:00:00.000Z' } })),
      expected: { plan: 'Pro', total: 1613, nextGrant: { amount: 900, on: 'Nov 3' } },
    });
  });
});

describe('countOf()', () => {
  test('whole credits with separators', () => {
    assert({
      given: 'a large count',
      should: 'write it with a thousands separator',
      actual: countOf(1000),
      expected: '1,000',
    });
  });
});
