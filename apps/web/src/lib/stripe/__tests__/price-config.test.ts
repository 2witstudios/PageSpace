import { describe, it, expect, vi } from 'vitest';

vi.mock('../../stripe-config', () => ({
  stripeConfig: {
    priceIds: { pro: 'price_pro' },
    orgPriceIds: { businessBase: 'price_org_business', extraSeat: 'price_extra_seat' },
    storageAddonPriceId: 'price_storage',
  },
}));

import {
  getTierFromPrice,
  getPersonalTierFromPrice,
  tierFromInvoiceLines,
  planPaidCentsFromInvoiceLines,
  personalSubscriptionItems,
  isStorageAddonPrice,
} from '../price-config';

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

  it('price identity: unrecognized or missing prices have no entitlement', () => {
    expect(tierFromInvoiceLines([subscriptionLine('price_unknown')])).toBe('free');
    expect(tierFromInvoiceLines([subscriptionLine(null)])).toBe('free');
    expect(tierFromInvoiceLines([])).toBe('free');
  });
});

describe('storage add-on lines', () => {
  const line = (price: string, amount: number) => ({ ...subscriptionLine(price), amount });

  it('given a Pro invoice with storage lines, should still resolve Pro', () => {
    expect(tierFromInvoiceLines([line('price_pro', 1500), line('price_storage', 1000)])).toBe('pro');
  });

  it('given only storage lines, should grant no plan', () => {
    expect(tierFromInvoiceLines([line('price_storage', 1000)])).toBe('free');
  });

  it('given the storage price is the only one recognized as storage, should not treat a stranger as storage', () => {
    expect(isStorageAddonPrice('price_storage')).toBe(true);
    expect(isStorageAddonPrice('price_other')).toBe(false);
    expect(isStorageAddonPrice('')).toBe(false);
  });

  it('given an invoice with no storage line, should leave the grant sizing alone', () => {
    expect(planPaidCentsFromInvoiceLines([line('price_pro', 1500)], 1500)).toBeUndefined();
  });

  it('given Pro + 3 blocks, should size the grant from the Pro share of what was paid only', () => {
    expect(planPaidCentsFromInvoiceLines([line('price_pro', 1500), line('price_storage', 1500)], 3000)).toBe(1500);
    // Tax on top is shared proportionally.
    expect(planPaidCentsFromInvoiceLines([line('price_pro', 1500), line('price_storage', 1500)], 3300)).toBe(1650);
  });

  it('given a storage-only proration invoice, should size no grant', () => {
    expect(planPaidCentsFromInvoiceLines([line('price_storage', 834)], 834)).toBe(0);
  });
});

describe('personal subscription item shape', () => {
  const item = (id: string, priceId: string, quantity = 1) => ({ id, priceId, quantity });

  it('given Pro alone or Pro + storage, should find the plan and storage items', () => {
    expect(personalSubscriptionItems([item('a', 'price_pro')], false)).toEqual({ planItem: item('a', 'price_pro'), storageItem: null });
    expect(personalSubscriptionItems([item('b', 'price_storage', 3), item('a', 'price_pro')], false))
      .toEqual({ planItem: item('a', 'price_pro'), storageItem: item('b', 'price_storage', 3) });
  });

  it('given a stranger item, two plan items, two storage items or a truncated list, should refuse', () => {
    expect(personalSubscriptionItems([item('a', 'price_pro'), item('x', 'price_other')], false)).toBeNull();
    expect(personalSubscriptionItems([item('a', 'price_pro'), item('b', 'price_pro')], false)).toBeNull();
    expect(personalSubscriptionItems([item('a', 'price_pro'), item('b', 'price_storage'), item('c', 'price_storage')], false)).toBeNull();
    expect(personalSubscriptionItems([item('a', 'price_pro')], true)).toBeNull();
    expect(personalSubscriptionItems([item('b', 'price_storage')], false)).toBeNull();
  });
});
