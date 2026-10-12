import { describe, it, expect, vi } from 'vitest';

vi.mock('../../stripe-config', () => ({
  stripeConfig: {
    priceIds: { pro: 'price_pro', business: 'price_business' },
    grandfatheredPriceIds: { founder: 'price_founder' },
    orgPriceIds: { businessBase: 'price_org_business', extraSeat: 'price_extra_seat' },
  },
}));

import { getTierFromPrice, getPersonalTierFromPrice, tierFromInvoiceLines } from '../price-config';

const subscriptionLine = (price: string | { id: string } | null) => ({
  parent: { subscription_item_details: { subscription_item: 'si_personal' } },
  pricing: { price_details: { price } },
});

describe('configured Stripe price identity', () => {
  it('SEAT-1 SEAT-2 (partial) organization prices cannot entitle a personal subscription or invoice', () => {
    expect(getPersonalTierFromPrice('price_pro')).toBe('pro');
    for (const price of ['price_org_business', 'price_extra_seat', 'price_business', 'price_founder', 'price_unknown']) {
      expect(getPersonalTierFromPrice(price)).toBe('free');
      expect(tierFromInvoiceLines([subscriptionLine(price)])).toBe('free');
    }
  });
  it('SEAT-2 (partial) unknown and retired prices never grant a paid tier by amount', () => {
    for (const amount of [1500, 2999, 5000, 10000, 19999]) {
      const invoiceLine = { ...subscriptionLine('price_unknown'), unit_amount_decimal: String(amount) };
      expect(tierFromInvoiceLines([invoiceLine])).toBe('free');
    }
    expect(getTierFromPrice('price_founder')).toBe('free');
    expect(getTierFromPrice('price_business')).toBe('free');
    expect(getTierFromPrice('price_org_business')).toBe('business');
    expect(getTierFromPrice('toString')).toBe('free');
  });
});

describe('personal invoice identity across subscription lines', () => {
  it('MON-2 (partial) recognized Pro is independent of unknown-line order and repeated plan lines', () => {
    const pro = subscriptionLine('price_pro');
    const retired = { ...subscriptionLine('price_retired'), amount: -500 };
    expect(tierFromInvoiceLines([retired, pro])).toBe('pro');
    expect(tierFromInvoiceLines([pro, retired, pro])).toBe('pro');
    expect(tierFromInvoiceLines([subscriptionLine({ id: 'price_pro' })])).toBe('pro');
  });

  it('MON-2 (partial) conflicting plan identities, organization-only and ad-hoc prices cannot fund a person', () => {
    expect(tierFromInvoiceLines([subscriptionLine('price_pro'), subscriptionLine('price_org_business')])).toBe('free');
    expect(tierFromInvoiceLines([subscriptionLine('price_org_business')])).toBe('free');
    expect(tierFromInvoiceLines([{ pricing: { price_details: { price: 'price_pro' } } }])).toBe('free');
  });

  it('MON-2 (partial) an old Pro credit cannot authorize an unknown replacement charge', () => {
    const oldPro = { ...subscriptionLine('price_pro'), amount: -500 };
    const replacement = { ...subscriptionLine('price_unknown'), amount: 2000 };
    for (const lines of [[oldPro, replacement], [replacement, oldPro]]) {
      expect(tierFromInvoiceLines(lines)).toBe('free');
    }
    expect(tierFromInvoiceLines([subscriptionLine('price_pro'), replacement])).toBe('free');
    expect(tierFromInvoiceLines([oldPro])).toBe('free');
  });

  it('MON-5 (partial) unrecognized or missing prices have no entitlement', () => {
    expect(tierFromInvoiceLines([subscriptionLine('price_unknown')])).toBe('free');
    expect(tierFromInvoiceLines([subscriptionLine(null)])).toBe('free');
    expect(tierFromInvoiceLines([])).toBe('free');
  });
});
