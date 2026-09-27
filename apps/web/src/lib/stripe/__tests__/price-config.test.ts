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

import { getTierFromPrice, tierFromInvoiceLine, unitAmountCentsFromDecimal } from '../price-config';

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

describe('tierFromInvoiceLine resolves the tier a paid invoice line bills', () => {
  const line = (price: string | { id: string } | null, unit_amount_decimal: string | null) => ({
    pricing: { price_details: { price }, unit_amount_decimal },
  });

  it('MON-5 (partial) an unmapped price on a $50 line (unit_amount_decimal "5000") resolves business, a $15 line pro', () => {
    expect(tierFromInvoiceLine(line('price_legacy_unmapped', '5000'))).toBe('business');
    expect(tierFromInvoiceLine(line({ id: 'price_legacy_unmapped' }, '1500'))).toBe('pro');
  });

  it('MON-5 (partial) a mapped price id wins over the amount', () => {
    expect(tierFromInvoiceLine(line('price_pro', '5000'))).toBe('pro');
  });

  it('MON-5 (partial) an unmapped price at an unknown amount, or with no amount, is free; a line with no price is undefined', () => {
    expect(tierFromInvoiceLine(line('price_legacy_unmapped', '4321'))).toBe('free');
    expect(tierFromInvoiceLine(line('price_legacy_unmapped', null))).toBe('free');
    expect(tierFromInvoiceLine(line(null, '5000'))).toBeUndefined();
    expect(tierFromInvoiceLine(undefined)).toBeUndefined();
  });
});
