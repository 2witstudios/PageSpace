import { describe, it, expect, vi } from 'vitest';

vi.mock('../../stripe-config', () => ({
  stripeConfig: {
    priceIds: { pro: 'price_pro', business: 'price_business' },
    grandfatheredPriceIds: { founder: 'price_founder' },
    orgPriceIds: { businessBase: 'price_org_business', extraSeat: 'price_extra_seat' },
  },
}));

import { getTierFromPrice, getPersonalTierFromPrice, tierFromInvoiceLine } from '../price-config';

describe('configured Stripe price identity', () => {
  it('SEAT-1 SEAT-2 (partial) organization prices cannot entitle a personal subscription or invoice', () => {
    expect(getPersonalTierFromPrice('price_pro')).toBe('pro');
    for (const price of ['price_org_business', 'price_extra_seat', 'price_business', 'price_founder', 'price_unknown']) {
      expect(getPersonalTierFromPrice(price)).toBe('free');
      expect(tierFromInvoiceLine({ pricing: { price_details: { price } } })).toBe('free');
    }
  });
  it('SEAT-2 (partial) unknown and retired prices never grant a paid tier by amount', () => {
    for (const amount of [1500, 2999, 5000, 10000, 19999]) {
      const invoiceLine = { pricing: { price_details: { price: 'price_unknown' }, unit_amount_decimal: String(amount) } };
      expect(tierFromInvoiceLine(invoiceLine)).toBe('free');
    }
    expect(getTierFromPrice('price_founder')).toBe('free');
    expect(getTierFromPrice('price_business')).toBe('free');
    expect(getTierFromPrice('price_org_business')).toBe('business');
    expect(getTierFromPrice('toString')).toBe('free');
  });
});

describe('tierFromInvoiceLine resolves the tier a paid invoice line bills', () => {
  const line = (price: string | { id: string } | null, unit_amount_decimal: string | null) => ({
    pricing: { price_details: { price }, unit_amount_decimal },
  });

  it('MON-5 (partial) invoice amounts cannot turn an unmapped price into a paid plan', () => {
    expect(tierFromInvoiceLine(line('price_legacy_unmapped', '5000'))).toBe('free');
    expect(tierFromInvoiceLine(line({ id: 'price_legacy_unmapped' }, '1500'))).toBe('free');
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
