import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../stripe-config', () => ({
  stripeConfig: {
    priceIds: { pro: 'price_pro', business: 'price_business' },
    grandfatheredPriceIds: { founder: 'price_founder' },
  },
}));

import { getTierFromPrice, unitAmountCentsFromDecimal } from '../price-config';

describe('unitAmountCentsFromDecimal reads a Stripe decimal amount without converting it', () => {
  it('MON-5 (partial) reads Stripe unit_amount_decimal as the cents it already is — "5000" is $50, never 500,000', () => {
    // Observed on Stripe TEST invoices: a $50 line has amount 5000 and unit_amount_decimal "5000".
    expect(unitAmountCentsFromDecimal('5000')).toBe(5000);
    expect(unitAmountCentsFromDecimal('1500')).toBe(1500);
    expect(unitAmountCentsFromDecimal('1499.6')).toBe(1500);
  });

  it('MON-5 (partial) a missing or unparseable decimal is null, so tier detection falls back to the price id alone', () => {
    expect(unitAmountCentsFromDecimal(null)).toBeNull();
    expect(unitAmountCentsFromDecimal(undefined)).toBeNull();
    expect(unitAmountCentsFromDecimal('')).toBeNull();
    expect(unitAmountCentsFromDecimal('abc')).toBeNull();
  });

  it('MON-5 (partial) an unmapped price at a known amount now resolves through the amount fallback', () => {
    expect(getTierFromPrice('price_unknown', unitAmountCentsFromDecimal('1500'))).toBe('pro');
    expect(getTierFromPrice('price_unknown', unitAmountCentsFromDecimal('5000'))).toBe('business');
  });
});
