import { describe, it, expect } from 'vitest';
import { TIER_PLAN_LIMITS } from '../subscription-tiers';
import {
  ORG_BUSINESS_TRIAL_DAYS,
  ORG_ID_METADATA_KEY,
  ORG_SUBSCRIPTION_KIND,
  isLiveOrgSubscriptionStatus,
  orgBusinessSubscriptionParams,
  orgBillingLockKey,
  orgCustomerCreateKey,
  orgCustomerCreateParams,
  orgCustomerDetails,
  orgSubscriptionCreateKey,
  orgSubscriptionHistory,
  orgExtraSeatQuantity,
  orgStripeIdempotencyKey,
  orgSubscriptionItems,
  orgTrialDays,
  pickAdoptableOrgSubscription,
  planSeatQuantitySync,
  type OrgBusinessPrices,
  type OrgSubscriptionCandidate,
} from '../org-subscription-core';

const PRICES: OrgBusinessPrices = { basePriceId: 'price_base', seatPriceId: 'price_seat' };
const ORG = 'org_northwind';

function candidate(overrides: Partial<OrgSubscriptionCandidate> = {}): OrgSubscriptionCandidate {
  return {
    id: 'sub_1',
    status: 'trialing',
    created: 100,
    metadata: { [ORG_ID_METADATA_KEY]: ORG, kind: ORG_SUBSCRIPTION_KIND },
    items: [
      { id: 'si_base', priceId: 'price_base', quantity: 1 },
      { id: 'si_seat', priceId: 'price_seat', quantity: 0 },
    ],
    ...overrides,
  };
}

describe('orgExtraSeatQuantity — the seat item quantity is max(0, seats − 5)', () => {
  it('A-8 SEAT-2 (partial) 5 or fewer seats bill no extra seat: quantity 0', () => {
    for (const seats of [0, 1, 2, 3, 4, 5]) expect(orgExtraSeatQuantity(seats)).toBe(0);
  });

  it('A-8 SEAT-2 (partial) 7 seats means quantity 2; 6 seats means 1; 15 seats (Northwind) means 10', () => {
    expect(orgExtraSeatQuantity(6)).toBe(1);
    expect(orgExtraSeatQuantity(7)).toBe(2);
    expect(orgExtraSeatQuantity(15)).toBe(10);
  });

  it('A-8 the included seat count comes from the one tier table, not a second constant', () => {
    const included = TIER_PLAN_LIMITS.business.includedSeats;
    expect(orgExtraSeatQuantity(included)).toBe(0);
    expect(orgExtraSeatQuantity(included + 1)).toBe(1);
  });

  it('A-8 refuses a seat count that is not a non-negative integer, rather than billing a guess', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => orgExtraSeatQuantity(bad)).toThrow(RangeError);
    }
  });
});

describe('orgStripeIdempotencyKey — derived from the org, the operation and the request', () => {
  it('SEAT-1 (partial) the same org, operation and params always derive the same key, so a replay is deduplicated by Stripe', () => {
    const a = orgStripeIdempotencyKey(ORG, 'customer.create', { name: 'Northwind Labs' });
    const b = orgStripeIdempotencyKey(ORG, 'customer.create', { name: 'Northwind Labs' });
    expect(a).toBe(b);
    expect(a.startsWith(`pagespace-org:${ORG}:customer.create:`)).toBe(true);
  });

  it('SEAT-1 (partial) another org, another operation or different params derive a different key', () => {
    const base = orgStripeIdempotencyKey(ORG, 'subscription.create', { quantity: 0 });
    expect(orgStripeIdempotencyKey('org_other', 'subscription.create', { quantity: 0 })).not.toBe(base);
    expect(orgStripeIdempotencyKey(ORG, 'customer.create', { quantity: 0 })).not.toBe(base);
    expect(orgStripeIdempotencyKey(ORG, 'subscription.create', { quantity: 1 })).not.toBe(base);
  });

  it('key order in the params does not change the key, and the key fits Stripe\'s 255-character limit', () => {
    const a = orgStripeIdempotencyKey(ORG, 'subscription.create', { a: 1, b: { c: 2, d: 3 } });
    const b = orgStripeIdempotencyKey(ORG, 'subscription.create', { b: { d: 3, c: 2 }, a: 1 });
    expect(a).toBe(b);
    expect(orgStripeIdempotencyKey('x'.repeat(200), 'seat-quantity.update', { q: 1 }).length).toBeLessThanOrEqual(255);
  });
});

describe('orgTrialDays — SEAT-8 trial on creation, never a second trial', () => {
  it('SEAT-8 (partial) a first Business subscription for the org starts with the trial', () => {
    expect(orgTrialDays({ hadSubscription: false })).toBe(ORG_BUSINESS_TRIAL_DAYS);
    expect(ORG_BUSINESS_TRIAL_DAYS).toBe(14);
  });

  it('SEAT-8 (partial) an org that already had a subscription gets no new trial', () => {
    expect(orgTrialDays({ hadSubscription: true })).toBe(0);
  });
});

describe('orgBusinessSubscriptionParams — the Business subscription Stripe is asked for', () => {
  it('SEAT-1 (partial) SEAT-2 (partial) A-8 base price once plus the extra-seat item at max(0, seats − 5), on the org customer', () => {
    const params = orgBusinessSubscriptionParams({ orgId: ORG, customerId: 'cus_org', seats: 7, prices: PRICES, trialDays: 14 });
    expect(params.customer).toBe('cus_org');
    expect(params.items).toEqual([
      { price: 'price_base', quantity: 1 },
      { price: 'price_seat', quantity: 2 },
    ]);
    expect(params.metadata).toEqual({ [ORG_ID_METADATA_KEY]: ORG, kind: ORG_SUBSCRIPTION_KIND });
  });

  it('A-8 an org with 5 or fewer seats still carries the seat item, at quantity 0, so adding a 6th seat is a quantity change', () => {
    const params = orgBusinessSubscriptionParams({ orgId: ORG, customerId: 'cus_org', seats: 1, prices: PRICES, trialDays: 14 });
    expect(params.items[1]).toEqual({ price: 'price_seat', quantity: 0 });
  });

  it('SEAT-8 (partial) with a trial: trial days set, and a trial that ends without a card cancels rather than running free', () => {
    const params = orgBusinessSubscriptionParams({ orgId: ORG, customerId: 'cus_org', seats: 1, prices: PRICES, trialDays: 14 });
    expect(params.trial_period_days).toBe(14);
    expect(params.trial_settings).toEqual({ end_behavior: { missing_payment_method: 'cancel' } });
    expect(params.payment_settings).toEqual({ save_default_payment_method: 'on_subscription' });
  });

  it('SEAT-8 (partial) without a trial there is no trial field and the first invoice waits for payment', () => {
    const params = orgBusinessSubscriptionParams({ orgId: ORG, customerId: 'cus_org', seats: 1, prices: PRICES, trialDays: 0 });
    expect(params.trial_period_days).toBeUndefined();
    expect(params.trial_settings).toBeUndefined();
    expect(params.payment_behavior).toBe('default_incomplete');
  });
});

describe('the org customer — the org\'s, never a person\'s, and never two', () => {
  it('SEAT-1 (partial) the create request carries only what never changes: the org id tag, never a userId', () => {
    expect(orgCustomerCreateParams({ orgId: ORG })).toEqual({ metadata: { [ORG_ID_METADATA_KEY]: ORG, kind: 'organization' } });
  });

  it('SEAT-1 (partial) name and billing email are set separately, after the create returns', () => {
    expect(orgCustomerDetails({ name: 'Northwind Labs', billingEmail: 'jono@northwind.test' })).toEqual({
      name: 'Northwind Labs',
      email: 'jono@northwind.test',
    });
    expect(orgCustomerDetails({ name: 'Northwind Labs', billingEmail: null })).toEqual({ name: 'Northwind Labs' });
  });

  it('SEAT-1 (P1-A) the customer.create key depends on the org alone: a rename or an owner email change between attempts replays the first create', () => {
    const key = orgCustomerCreateKey(ORG);
    expect(key).toBe(orgCustomerCreateKey(ORG));
    expect(key.startsWith(`pagespace-org:${ORG}:customer.create:`)).toBe(true);
    expect(orgCustomerCreateKey('org_other')).not.toBe(key);
  });
});

describe('the subscription generation — a new subscription after an ended one is a new request (P1-B)', () => {
  const params = orgBusinessSubscriptionParams({ orgId: ORG, customerId: 'cus_org', seats: 1, prices: PRICES, trialDays: 0 });

  it('SEAT-1 (partial) the same attempt replays: same params and same previous subscription derive the same key', () => {
    expect(orgSubscriptionCreateKey(ORG, params, 'sub_b')).toBe(orgSubscriptionCreateKey(ORG, params, 'sub_b'));
  });

  it('SEAT-1 (partial) identical params after a different previous subscription derive a different key, so Stripe cannot replay the dead one', () => {
    expect(orgSubscriptionCreateKey(ORG, params, 'sub_b')).not.toBe(orgSubscriptionCreateKey(ORG, params, 'sub_a'));
    expect(orgSubscriptionCreateKey(ORG, params, null)).not.toBe(orgSubscriptionCreateKey(ORG, params, 'sub_a'));
  });

  it('SEAT-8 (partial) the org\'s Stripe history counts every subscription stamped with it, ended ones included; the newest is the previous generation', () => {
    const history = orgSubscriptionHistory(
      [
        candidate({ id: 'sub_old', status: 'canceled', created: 100 }),
        candidate({ id: 'sub_new', status: 'incomplete_expired', created: 200 }),
        candidate({ id: 'sub_other', created: 300, metadata: { [ORG_ID_METADATA_KEY]: 'org_other' } }),
      ],
      { orgId: ORG },
    );
    expect(history).toEqual({ hadSubscription: true, previousSubscriptionId: 'sub_new' });
    expect(orgSubscriptionHistory([], { orgId: ORG })).toEqual({ hadSubscription: false, previousSubscriptionId: null });
  });
});

describe('orgBillingLockKey', () => {
  it('one lock key per org, shared by provisioning and the org delete', () => {
    expect(orgBillingLockKey(ORG)).toBe(`org_billing:${ORG}`);
  });
});

describe('isLiveOrgSubscriptionStatus', () => {
  it('canceled and incomplete_expired are over; every other status is a subscription the org still has', () => {
    for (const s of ['trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused']) expect(isLiveOrgSubscriptionStatus(s)).toBe(true);
    for (const s of ['canceled', 'incomplete_expired']) expect(isLiveOrgSubscriptionStatus(s)).toBe(false);
  });
});

describe('pickAdoptableOrgSubscription — recover a subscription Stripe has but the database lost', () => {
  it('SEAT-1 (partial) adopts the live subscription stamped with this org and carrying the base price', () => {
    expect(pickAdoptableOrgSubscription([candidate()], { orgId: ORG, prices: PRICES })?.id).toBe('sub_1');
  });

  it('ignores canceled subscriptions, another org\'s stamp, and subscriptions without the base price', () => {
    const list = [
      candidate({ id: 'sub_canceled', status: 'canceled' }),
      candidate({ id: 'sub_other', metadata: { [ORG_ID_METADATA_KEY]: 'org_other' } }),
      candidate({ id: 'sub_nobase', items: [{ id: 'si', priceId: 'price_pro', quantity: 1 }] }),
    ];
    expect(pickAdoptableOrgSubscription(list, { orgId: ORG, prices: PRICES })).toBeNull();
  });

  it('with more than one live match, adopts the oldest, deterministically', () => {
    const list = [candidate({ id: 'sub_new', created: 200 }), candidate({ id: 'sub_old', created: 100 })];
    expect(pickAdoptableOrgSubscription(list, { orgId: ORG, prices: PRICES })?.id).toBe('sub_old');
  });
});

describe('orgSubscriptionItems — the linkage stored on the org', () => {
  it('SEAT-1 (partial) finds the base item and the seat item with its quantity', () => {
    expect(orgSubscriptionItems(candidate(), PRICES)).toEqual({ baseItemId: 'si_base', seatItem: { id: 'si_seat', quantity: 0 } });
  });

  it('reports a missing seat item as null, and a subscription without the base price as not an org Business subscription', () => {
    expect(orgSubscriptionItems(candidate({ items: [{ id: 'si_base', priceId: 'price_base', quantity: 1 }] }), PRICES)).toEqual({
      baseItemId: 'si_base',
      seatItem: null,
    });
    expect(orgSubscriptionItems(candidate({ items: [{ id: 'si', priceId: 'price_pro', quantity: 1 }] }), PRICES)).toBeNull();
  });
});

describe('planSeatQuantitySync — raising or lowering the extra-seat quantity', () => {
  const stored = { seatItemId: 'si_seat', extraSeatQuantity: 0, seatRevision: 0 };

  it('A-8 SEAT-2 (partial) 5 seats on a quantity-0 item is a no-op; 6 seats updates the item to 1', () => {
    expect(planSeatQuantitySync({ orgId: ORG, stored, seats: 5 })).toEqual({ kind: 'noop', quantity: 0 });
    const plan = planSeatQuantitySync({ orgId: ORG, stored, seats: 6 });
    expect(plan).toMatchObject({ kind: 'update', itemId: 'si_seat', quantity: 1, nextRevision: 1 });
  });

  it('A-8 a replay of the same change derives the same key; the same quantity reached again later derives a new one', () => {
    const first = planSeatQuantitySync({ orgId: ORG, stored, seats: 7 });
    const replay = planSeatQuantitySync({ orgId: ORG, stored, seats: 7 });
    expect(first.kind === 'update' && replay.kind === 'update' && first.idempotencyKey === replay.idempotencyKey).toBe(true);
    // 0 → 2, then 2 → 0, then 0 → 2 again: the third change is a NEW request, not a replay of the first.
    const later = planSeatQuantitySync({ orgId: ORG, stored: { ...stored, seatRevision: 2 }, seats: 7 });
    expect(later.kind === 'update' && first.kind === 'update' && later.idempotencyKey !== first.idempotencyKey).toBe(true);
  });

  it('A-8 the proration choice is part of the request, so a prorated and an unprorated change derive different keys', () => {
    const prorated = planSeatQuantitySync({ orgId: ORG, stored, seats: 7 });
    const unprorated = planSeatQuantitySync({ orgId: ORG, stored, seats: 7, prorationBehavior: 'none' });
    expect(prorated.kind === 'update' && unprorated.kind === 'update' && prorated.idempotencyKey !== unprorated.idempotencyKey).toBe(true);
  });
});
