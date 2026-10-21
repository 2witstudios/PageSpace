import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { countOf, creditsCardOf, resetLabel } from './avatar-menu-model';

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
  test('the monthly figures, the plan and the renewal date from /api/credits', () => {
    const card = creditsCardOf(balance());

    assert({
      given: 'a paid balance with 612 of 900 monthly credits, 1,000 top-up credits and 14 reserved',
      should: 'show the monthly credits left against the allowance, the meter, the bonus and the reserve',
      actual: card === null ? null : { plan: card.plan, resets: card.resets, left: card.left, allowance: card.allowance, percent: card.percent, bonus: card.bonus, reserved: card.reserved },
      expected: { plan: 'Pro', resets: 'Nov 3', left: 612, allowance: 900, percent: 68, bonus: 1000, reserved: 14 },
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

  test('a one-time grant with no renewal date', () => {
    assert({
      given: 'a free balance with no period end',
      should: 'leave the renewal out',
      actual: creditsCardOf(balance({ subscriptionTier: 'free', monthly: { remaining: 0, allowance: 1000, periodEnd: null } }))?.resets ?? 'none',
      expected: 'none',
    });
  });

  test('a balance that is not a whole number of credits', () => {
    const card = creditsCardOf(balance({ spendable: 16126.4, topup: { remaining: 10003 }, reserved: 7.5 }));
    assert({
      given: 'cents that leave a fraction of a credit',
      should: 'round every figure to a whole credit',
      actual: card === null ? null : [card.left, card.bonus, card.reserved],
      expected: [612, 1000, 1],
    });
  });

  test('a debt-free overdraw never shows a meter past full', () => {
    assert({
      given: 'monthly credits left above the allowance',
      should: 'cap the meter at 100',
      actual: creditsCardOf(balance({ spendable: 15000, topup: { remaining: 0 }, monthly: { remaining: 15000, allowance: 9000, periodEnd: null } }))?.percent,
      expected: 100,
    });
  });
});

describe('countOf() and resetLabel()', () => {
  test('whole credits with separators, and a short renewal date', () => {
    assert({
      given: 'a large count and a renewal timestamp',
      should: 'write the count with a thousands separator and the date as "Mon D"',
      actual: [countOf(1000), resetLabel('2026-11-03T12:00:00.000Z'), resetLabel('not a date'), resetLabel(null)],
      expected: ['1,000', 'Nov 3', null, null],
    });
  });
});

describe('creditsCardOf() with no monthly allowance', () => {
  test('shows an empty meter rather than dividing by zero', () => {
    const card = creditsCardOf(balance({ monthly: { remaining: 0, allowance: 0, periodEnd: null }, spendable: 0, topup: { remaining: 0 } }));
    assert({ given: 'a zero allowance', should: 'report 0 percent', actual: card?.percent, expected: 0 });
  });

  test('clamps the meter to 0-100', () => {
    const over = creditsCardOf(balance({ spendable: 50000, topup: { remaining: 0 } }));
    assert({ given: 'more credits left than the allowance', should: 'cap at 100 percent', actual: over?.percent, expected: 100 });
  });
});
