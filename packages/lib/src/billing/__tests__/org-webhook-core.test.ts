import { describe, it, expect } from 'vitest';
import { ORG_ID_METADATA_KEY, ORG_SUBSCRIPTION_KIND } from '../org-subscription-core';
import { routeBillingOwner, orgInvoiceExtraSeats, planOrgSubscriptionMirror, planOrgSeatItemMirror } from '../org-webhook-core';

const ORG = 'org_northwind';

describe('routeBillingOwner', () => {
  it("SEAT-7 (partial) an org customer's event routes to the org, whatever its metadata says about kind", () => {
    expect(routeBillingOwner({ customerOrgId: ORG, metadata: null })).toEqual({ kind: 'org', orgId: ORG });
    expect(routeBillingOwner({ customerOrgId: ORG, metadata: { kind: ORG_SUBSCRIPTION_KIND, [ORG_ID_METADATA_KEY]: ORG } })).toEqual({
      kind: 'org',
      orgId: ORG,
    });
  });

  it("SEAT-7 (partial) a person's event (customer is no org's, no org tag) takes the personal path", () => {
    expect(routeBillingOwner({ customerOrgId: null, metadata: null })).toEqual({ kind: 'person' });
    expect(routeBillingOwner({ customerOrgId: null, metadata: { type: 'gift_subscription' } })).toEqual({ kind: 'person' });
  });

  it('SEAT-7 (partial) an org-tagged event whose customer is no org of ours never reaches the personal path', () => {
    expect(routeBillingOwner({ customerOrgId: null, metadata: { kind: ORG_SUBSCRIPTION_KIND } })).toEqual({
      kind: 'org_unlinked',
      taggedOrgId: null,
    });
    expect(routeBillingOwner({ customerOrgId: null, metadata: { [ORG_ID_METADATA_KEY]: ORG } })).toEqual({
      kind: 'org_unlinked',
      taggedOrgId: ORG,
    });
  });

  it("SEAT-7 (partial) an event tagged for org B on org A's customer is refused, never applied to either", () => {
    expect(routeBillingOwner({ customerOrgId: ORG, metadata: { [ORG_ID_METADATA_KEY]: 'org_other' } })).toEqual({
      kind: 'org_mismatch',
      orgId: ORG,
      taggedOrgId: 'org_other',
    });
  });
});

describe('orgInvoiceExtraSeats', () => {
  const SEAT = 'price_seat';
  const line = (price: string | { id: string } | null, quantity: number | null) => ({
    quantity,
    pricing: price === null ? null : { price_details: { price } },
  });

  it('A-8 the extra seats an org invoice billed are the quantity on its extra-seat line (a count, not an amount)', () => {
    expect(orgInvoiceExtraSeats([line('price_base', 1), line(SEAT, 10)], SEAT)).toBe(10);
    expect(orgInvoiceExtraSeats([line('price_base', 1), line({ id: SEAT }, 2)], SEAT)).toBe(2);
    expect(orgInvoiceExtraSeats([line('price_base', 1), line(SEAT, 0)], SEAT)).toBe(0);
  });

  it('A-8 an invoice with no extra-seat line, or no configured seat price, reports null (the caller falls back)', () => {
    expect(orgInvoiceExtraSeats([line('price_base', 1)], SEAT)).toBeNull();
    expect(orgInvoiceExtraSeats([line(SEAT, 3)], '')).toBeNull();
    expect(orgInvoiceExtraSeats([line(SEAT, null)], SEAT)).toBeNull();
  });

  it('A-8 proration lines for the seat price do not stack: the largest positive quantity is the period seat count', () => {
    expect(orgInvoiceExtraSeats([line(SEAT, 2), line(SEAT, 3), line('price_base', 1)], SEAT)).toBe(3);
  });
});

describe('planOrgSubscriptionMirror', () => {
  it('SEAT-7 (partial) the fetched subscription is mirrored only onto the row that names it', () => {
    expect(planOrgSubscriptionMirror({ storedSubscriptionId: 'sub_1', fetchedSubscriptionId: 'sub_1' })).toBe('apply');
  });

  it('SEAT-7 (partial) a late event about an ended, replaced subscription never overwrites the current one', () => {
    expect(planOrgSubscriptionMirror({ storedSubscriptionId: 'sub_2', fetchedSubscriptionId: 'sub_1' })).toBe('ignore_other_subscription');
  });

  it('SEAT-7 (partial) an org with no stored subscription row is left to the provisioning path', () => {
    expect(planOrgSubscriptionMirror({ storedSubscriptionId: null, fetchedSubscriptionId: 'sub_1' })).toBe('no_row');
  });
});

describe('planOrgSeatItemMirror — the mirror refreshes the seat item from what Stripe says now (review 3+4 P2-8)', () => {
  const prices = { basePriceId: 'price_base', seatPriceId: 'price_seat' };
  const stored = { stripeBaseItemId: 'si_base', stripeSeatItemId: 'si_seat', extraSeatQuantity: 2, seatRevision: 4 };

  it('SEAT-7 (partial) a quantity changed in Stripe outside the app (stored 2, Stripe 3) is mirrored, and the seat revision moves so no later change reuses a key', () => {
    const items = [
      { id: 'si_base', priceId: 'price_base', quantity: 1 },
      { id: 'si_seat', priceId: 'price_seat', quantity: 3 },
    ];
    expect(planOrgSeatItemMirror({ stored, items, prices })).toEqual({ extraSeatQuantity: 3, seatRevision: 5 });
  });

  it('SEAT-7 (partial) replaced item ids are mirrored; the same quantity on a new item moves no revision', () => {
    const items = [
      { id: 'si_base_2', priceId: 'price_base', quantity: 1 },
      { id: 'si_seat_2', priceId: 'price_seat', quantity: 2 },
    ];
    expect(planOrgSeatItemMirror({ stored, items, prices })).toEqual({ stripeBaseItemId: 'si_base_2', stripeSeatItemId: 'si_seat_2' });
  });

  it('nothing changed is an empty patch; a subscription without the base item, or with no seat item, never overwrites the stored linkage', () => {
    const same = [
      { id: 'si_base', priceId: 'price_base', quantity: 1 },
      { id: 'si_seat', priceId: 'price_seat', quantity: 2 },
    ];
    expect(planOrgSeatItemMirror({ stored, items: same, prices })).toEqual({});
    expect(planOrgSeatItemMirror({ stored, items: [{ id: 'si_x', priceId: 'price_other', quantity: 9 }], prices })).toEqual({});
    expect(planOrgSeatItemMirror({ stored, items: [{ id: 'si_base_3', priceId: 'price_base', quantity: 1 }], prices })).toEqual({ stripeBaseItemId: 'si_base_3' });
  });
});
