import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import type { CreditBalance } from '@/retained/hooks/useCreditBalance';

const state = vi.hoisted(() => ({ balance: null as CreditBalance | null }));

vi.mock('@/retained/hooks/useCreditBalance', () => ({
  useCreditBalance: () => ({ balance: state.balance, isLoading: false, isError: false }),
}));
vi.mock('@/retained/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => ({ showBilling: true }) }));
vi.mock('@/retained/components/billing/BuyCreditsButton', () => ({ BuyCreditsButton: () => <button type="button">Buy credits</button> }));
vi.mock('@/retained/components/billing/UpgradeTierButton', () => ({ UpgradeTierButton: () => null }));

const { CreditBalanceCard } = await import('./CreditBalanceCard');

const balance = (overrides: Partial<CreditBalance> = {}): CreditBalance => ({
  billingEnabled: true,
  // Cents of credit value: 10 cents to the credit.
  monthly: { remaining: 6120, allowance: 9000, periodEnd: '2026-12-03T12:00:00.000Z' },
  topup: { remaining: 10000 },
  debt: 0,
  spendable: 16120,
  reserved: 0,
  subscriptionTier: 'pro',
  ...overrides,
});

const text = (value: CreditBalance) => {
  state.balance = value;
  return renderToStaticMarkup(<CreditBalanceCard />).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
};

beforeEach(() => {
  state.balance = null;
});

describe('CreditBalanceCard', () => {
  test('a paid balance', () => {
    const shown = text(balance());

    assert({
      given: 'a Pro balance of 1,612 spendable credits, 1,000 of them top-ups, on a 900 allowance',
      should: 'show the one total, the 900 arriving on Dec 3, and the top-up share',
      actual: [shown.includes('1,612 credits'), shown.includes('900 more on Dec 3'), shown.includes('Includes 1,000 from top-ups')],
      expected: [true, true, true],
    });
  });

  test('rollover never reads as used or reset', () => {
    const shown = text(balance({ spendable: 18000, topup: { remaining: 0 }, monthly: { remaining: 18000, allowance: 9000, periodEnd: '2026-12-03T12:00:00.000Z' } }));

    assert({
      given: 'a carried balance above one allowance',
      should: 'show no "of N used" figure, no meter and no reset date',
      actual: [shown.includes('1,800 credits'), / used/.test(shown), /reset/i.test(shown), state.balance !== null && renderToStaticMarkup(<CreditBalanceCard />).includes('progressbar')],
      expected: [true, false, false, false],
    });
  });

  test('debt is paid out of the next allowance', () => {
    const shown = text(balance({ debt: 2500, spendable: -2500, topup: { remaining: 0 }, monthly: { remaining: 0, allowance: 9000, periodEnd: '2026-12-03T12:00:00.000Z' } }));

    assert({
      given: 'a 250-credit debt on a 900 allowance',
      should: 'promise only the 650 that will arrive',
      actual: [shown.includes('650 more on Dec 3'), shown.includes('900 more')],
      expected: [true, false],
    });
  });

  test('debt already netted from a top-up is not subtracted again', () => {
    const shown = text(balance({ debt: 1000, spendable: 2000, topup: { remaining: 3000 }, monthly: { remaining: 0, allowance: 9000, periodEnd: '2026-12-03T12:00:00.000Z' } }));

    assert({
      given: 'a 100-credit debt against 300 top-up credits, nothing carried, a 900 allowance',
      should: 'promise the 900 the total will actually rise by',
      actual: shown.includes('900 more on Dec 3'),
      expected: true,
    });
  });

  test('a free one-time grant', () => {
    const shown = text(balance({ subscriptionTier: 'free', topup: { remaining: 0 }, spendable: 400, monthly: { remaining: 400, allowance: 1000, periodEnd: null } }));

    assert({
      given: 'a free balance with no period end',
      should: 'show the total with no next grant and no top-up note',
      actual: [shown.includes('40 credits'), shown.includes('more on'), shown.includes('from top-ups')],
      expected: [true, false, false],
    });
  });
});
