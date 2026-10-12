import { describe, it, expect } from 'vitest';
import { TIER_PLAN_LIMITS } from '../subscription-tiers';
import {
  ORG_ID_METADATA_KEY,
  ORG_SUBSCRIPTION_KIND,
  isLiveOrgSubscriptionStatus,
  orgBusinessSubscriptionParams,
  orgBillingLockKey,
  orgCustomerCreateKey,
  orgCustomerCreateParams,
  orgCustomerDetails,
  orgSubscriptionCreateKey,
  orgExtraSeatQuantity,
  orgStripeIdempotencyKey,
  orgSubscriptionItems,
  orgPaymentStep,
  orgSubscriptionMayOwePayment,
  orgReactivationReadsInvoice,
  planOrgReactivation,
  planSeatQuantitySync,
  ORG_FUNDING_PENDING_WINDOW_SECONDS,
  type OrgBusinessPrices,
  type OrgLatestInvoice,
  type OrgSubscriptionCandidate,
  type OrgSubscriptionFacts,
} from '../org-subscription-core';
import { GIFT_SUBSCRIPTION_METADATA_TYPE } from '../wallet-funding';

const PRICES: OrgBusinessPrices = { basePriceId: 'price_base', seatPriceId: 'price_seat' };
const ORG = 'org_northwind';
const NOW = 1_800_000_000;

function candidate(overrides: Partial<OrgSubscriptionCandidate> = {}): OrgSubscriptionCandidate {
  return {
    id: 'sub_1',
    status: 'active',
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

describe('orgBusinessSubscriptionParams — the Business subscription Stripe is asked for', () => {
  it('SEAT-1 (partial) SEAT-2 (partial) A-8 base price once plus the extra-seat item at max(0, seats − 5), on the org customer', () => {
    const params = orgBusinessSubscriptionParams({ orgId: ORG, customerId: 'cus_org', seats: 7, prices: PRICES });
    expect(params.customer).toBe('cus_org');
    expect(params.items).toEqual([
      { price: 'price_base', quantity: 1 },
      { price: 'price_seat', quantity: 2 },
    ]);
    expect(params.metadata).toEqual({ [ORG_ID_METADATA_KEY]: ORG, kind: ORG_SUBSCRIPTION_KIND });
  });

  it('A-8 an org with 5 or fewer seats still carries the seat item, at quantity 0, so adding a 6th seat is a quantity change', () => {
    const params = orgBusinessSubscriptionParams({ orgId: ORG, customerId: 'cus_org', seats: 1, prices: PRICES });
    expect(params.items[1]).toEqual({ price: 'price_seat', quantity: 0 });
  });

  it('SEAT-8 (partial) D-OW-30 there is no org trial: no trial field ever, the first invoice waits for a card (default_incomplete), and the card is saved on the subscription', () => {
    for (const seats of [1, 5, 7]) {
      const params = orgBusinessSubscriptionParams({ orgId: ORG, customerId: 'cus_org', seats, prices: PRICES });
      expect(params).not.toHaveProperty('trial_period_days');
      expect(params).not.toHaveProperty('trial_settings');
      expect(params.payment_behavior).toBe('default_incomplete');
      expect(params.payment_settings).toEqual({ save_default_payment_method: 'on_subscription' });
    }
  });
});

describe('orgPaymentStep — what the client must do to pay for the org subscription (a new org, or recovery from a lapse)', () => {
  const openInvoice = { status: 'open', amountDueCents: 5000, clientSecret: 'pi_123_secret_abc', paidAtSeconds: null, invoice: {} };

  it('SEAT-8 (partial) SEAT-9 (partial) a new or re-subscribed org whose subscription is incomplete gets the open invoice\'s client secret to confirm the card', () => {
    expect(orgPaymentStep({ subscriptionStatus: 'incomplete', latestInvoice: openInvoice })).toEqual({
      kind: 'confirm_payment',
      clientSecret: 'pi_123_secret_abc',
    });
  });

  it('SEAT-9 (partial) a past_due or unpaid org with an open invoice gets the client secret too, so a new card pays what is owed', () => {
    for (const subscriptionStatus of ['past_due', 'unpaid']) {
      expect(orgPaymentStep({ subscriptionStatus, latestInvoice: openInvoice })).toEqual({ kind: 'confirm_payment', clientSecret: 'pi_123_secret_abc' });
    }
  });

  it('an active subscription, a paid or zero invoice, a missing secret or no invoice needs no payment step', () => {
    expect(orgPaymentStep({ subscriptionStatus: 'active', latestInvoice: openInvoice })).toEqual({ kind: 'none' });
    expect(orgPaymentStep({ subscriptionStatus: 'incomplete', latestInvoice: { ...openInvoice, status: 'paid' } })).toEqual({ kind: 'none' });
    expect(orgPaymentStep({ subscriptionStatus: 'incomplete', latestInvoice: { ...openInvoice, amountDueCents: 0 } })).toEqual({ kind: 'none' });
    expect(orgPaymentStep({ subscriptionStatus: 'incomplete', latestInvoice: { ...openInvoice, clientSecret: null } })).toEqual({ kind: 'none' });
    expect(orgPaymentStep({ subscriptionStatus: 'incomplete', latestInvoice: { ...openInvoice, clientSecret: '' } })).toEqual({ kind: 'none' });
    expect(orgPaymentStep({ subscriptionStatus: 'incomplete', latestInvoice: null })).toEqual({ kind: 'none' });
  });

  it('only incomplete, past_due and unpaid subscriptions may owe a payment (so only they read the invoice)', () => {
    for (const s of ['incomplete', 'past_due', 'unpaid']) expect(orgSubscriptionMayOwePayment(s)).toBe(true);
    for (const s of ['active', 'trialing', 'canceled', 'incomplete_expired', 'paused']) expect(orgSubscriptionMayOwePayment(s)).toBe(false);
  });

  it('an ended subscription never hands out a secret: the org subscribes again instead', () => {
    for (const subscriptionStatus of ['canceled', 'incomplete_expired']) {
      expect(orgPaymentStep({ subscriptionStatus, latestInvoice: openInvoice })).toEqual({ kind: 'none' });
    }
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
  const params = orgBusinessSubscriptionParams({ orgId: ORG, customerId: 'cus_org', seats: 1, prices: PRICES });

  it('SEAT-1 (partial) the same attempt replays: same params and same previous subscription derive the same key', () => {
    expect(orgSubscriptionCreateKey(ORG, params, 'sub_b')).toBe(orgSubscriptionCreateKey(ORG, params, 'sub_b'));
  });

  it('SEAT-1 (partial) identical params after a different previous subscription derive a different key, so Stripe cannot replay the dead one', () => {
    expect(orgSubscriptionCreateKey(ORG, params, 'sub_b')).not.toBe(orgSubscriptionCreateKey(ORG, params, 'sub_a'));
    expect(orgSubscriptionCreateKey(ORG, params, null)).not.toBe(orgSubscriptionCreateKey(ORG, params, 'sub_a'));
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

describe('planOrgReactivation — D-OW-44: reactivation only repairs states PageSpace itself creates', () => {
  const payable: OrgLatestInvoice = { status: 'open', amountDueCents: 5000, clientSecret: 'pi_123_secret_abc', paidAtSeconds: null, invoice: {} };
  const facts = (overrides: Partial<OrgSubscriptionFacts> = {}): OrgSubscriptionFacts => ({
    ...candidate(),
    collectionMethod: 'charge_automatically',
    latestInvoice: null,
    ...overrides,
  });
  const plan = (
    subscriptions: OrgSubscriptionFacts[],
    storedSubscriptionId: string | null = 'sub_1',
    fundedSubscriptionIds: ReadonlySet<string> = new Set(['sub_1']),
  ) => planOrgReactivation({ orgId: ORG, prices: PRICES, storedSubscriptionId, subscriptions, fundedSubscriptionIds, nowSeconds: NOW });
  const support = (reason: string) => ({ kind: 'requires_support', reason });

  describe('already_active', () => {
    it('SEAT-1 (partial) the stored subscription, active in Stripe with the configured plan and automatic collection, is returned as it is', () => {
      const sub = facts();
      expect(plan([sub])).toEqual({ kind: 'already_active', subscription: sub, adopted: false, items: { baseItemId: 'si_base', seatItem: { id: 'si_seat', quantity: 0 } } });
    });

    it('SEAT-1 (partial) an active subscription Stripe has but the database lost (a create whose row was never written) is adopted', () => {
      expect(plan([facts()], null)).toMatchObject({ kind: 'already_active', adopted: true });
    });
  });

  describe('an active subscription is only already_active once its funding is verified (D-OW-44 applied to funding, D-OW-30)', () => {
    const unfunded = new Set<string>();
    const items = { baseItemId: 'si_base', seatItem: { id: 'si_seat', quantity: 0 } };
    const PAID_AT = NOW - 60;
    const line = (price: string, amount: number, discount = 0) => ({
      amount,
      discount_amounts: discount ? [{ amount: discount }] : [],
      pricing: { price_details: { price } },
      parent: { subscription_item_details: { subscription_item: price === 'price_base' ? 'si_base' : 'si_seat' } },
    });
    const adhoc = { amount: 1000, pricing: { price_details: { price: 'price_adhoc' } }, parent: null };
    /** A paid latest invoice, Stripe-shaped, with every line. */
    const paidInvoice = (over: { lines?: Array<ReturnType<typeof line> | typeof adhoc>; paid?: number; gift?: boolean; hasMore?: boolean; sub?: string; paidAt?: number | null } = {}): OrgLatestInvoice => ({
      status: 'paid',
      amountDueCents: 0,
      clientSecret: null,
      paidAtSeconds: over.paidAt === undefined ? PAID_AT : over.paidAt,
      invoice: {
        amount_paid: over.paid ?? 5000,
        subtotal: 5000,
        billing_reason: 'subscription_create',
        parent: { subscription_details: { subscription: over.sub ?? 'sub_1', metadata: over.gift ? { type: GIFT_SUBSCRIPTION_METADATA_TYPE } : {} } },
        lines: { has_more: over.hasMore ?? false, data: over.lines ?? [line('price_base', 5000), line('price_seat', 0)] },
      },
    });
    const giftLines = [line('price_base', 5000, 5000), line('price_seat', 0)];
    const giftMetadata = { [ORG_ID_METADATA_KEY]: ORG, kind: ORG_SUBSCRIPTION_KIND, type: GIFT_SUBSCRIPTION_METADATA_TYPE };

    it('SEAT-9 (partial) an active subscription with a recorded funding proof is already_active, whatever its latest invoice says', () => {
      expect(plan([facts({ latestInvoice: paidInvoice({ paid: 0 }) })])).toMatchObject({ kind: 'already_active' });
    });

    it('SEAT-8 (partial) SEAT-9 (partial) active, unfunded, and its latest invoice is the evidence invoice.paid records (orgSubscriptionFundingBasis): funding_pending, nothing to pay, nothing to write', () => {
      const sub = facts({ latestInvoice: paidInvoice() });
      expect(plan([sub], 'sub_1', unfunded)).toEqual({ kind: 'funding_pending', subscription: sub, adopted: false, items });
    });

    it('SEAT-9 (partial) a lost-row active subscription paid with money is adopted while its funding is pending', () => {
      expect(plan([facts({ latestInvoice: paidInvoice() })], null, unfunded)).toMatchObject({ kind: 'funding_pending', adopted: true });
    });

    it('SEAT-9 (partial) a $0 paid invoice on the org\'s own GIFTED subscription is funding_pending (a gift is verified funding)', () => {
      const sub = facts({ metadata: giftMetadata, latestInvoice: paidInvoice({ lines: giftLines, paid: 0, gift: true }) });
      expect(plan([sub], 'sub_1', unfunded)).toMatchObject({ kind: 'funding_pending' });
    });

    it('SEAT-9 (partial) a gift on a subscription the org has not stored is not its own: the webhook refuses that gift, so it needs support', () => {
      const sub = facts({ metadata: giftMetadata, latestInvoice: paidInvoice({ lines: giftLines, paid: 0, gift: true }) });
      expect(plan([sub], null, unfunded)).toEqual(support('unfunded_active'));
    });

    it(`SEAT-9 (partial) pending is time-boxed: paid more than ORG_FUNDING_PENDING_WINDOW_SECONDS ago with still no proof means the webhook never recorded it, so support`, () => {
      const at = (paidAt: number) => plan([facts({ latestInvoice: paidInvoice({ paidAt }) })], 'sub_1', unfunded);
      expect(at(NOW - ORG_FUNDING_PENDING_WINDOW_SECONDS)).toMatchObject({ kind: 'funding_pending' });
      expect(at(NOW - ORG_FUNDING_PENDING_WINDOW_SECONDS - 1)).toEqual(support('unfunded_active'));
    });

    const neverFunding: Array<[string, OrgLatestInvoice | null]> = [
      ['a $0 paid invoice that is not a gift (a 100% coupon, a trial-shaped invoice)', paidInvoice({ lines: giftLines, paid: 0 })],
      ['money paid only for an ad-hoc line while the Business base is fully discounted (the webhook records nothing)', paidInvoice({ lines: [...giftLines, adhoc], paid: 1000 })],
      ['a truncated line list (never evidence)', paidInvoice({ hasMore: true })],
      ['a paid invoice of another subscription', paidInvoice({ sub: 'sub_other' })],
      ['a paid invoice with no paid-at time', paidInvoice({ paidAt: null })],
      ['an open invoice', { ...paidInvoice(), status: 'open', amountDueCents: 5000, clientSecret: 'pi_secret' }],
      ['a void invoice', { ...paidInvoice(), status: 'void' }],
      ['no invoice at all', null],
    ];
    it.each(neverFunding)('SEAT-8 (partial) D-OW-30: active and unfunded with %s needs support — Reactivate can never produce funding for it', (_label, latestInvoice) => {
      expect(plan([facts({ latestInvoice })], 'sub_1', unfunded)).toEqual(support('unfunded_active'));
    });

    it('funding proof for another subscription does not fund this one', () => {
      expect(plan([facts({ latestInvoice: paidInvoice({ lines: giftLines, paid: 0 }) })], 'sub_1', new Set(['sub_old']))).toEqual(support('unfunded_active'));
    });

    it('the invoice is read only where the decision needs it: a payment may be owed, or an active subscription is unfunded', () => {
      expect(orgReactivationReadsInvoice({ id: 'sub_1', status: 'active' }, unfunded)).toBe(true);
      expect(orgReactivationReadsInvoice({ id: 'sub_1', status: 'active' }, new Set(['sub_1']))).toBe(false);
      for (const status of ['incomplete', 'past_due', 'unpaid']) expect(orgReactivationReadsInvoice({ id: 'sub_1', status }, new Set(['sub_1']))).toBe(true);
      for (const status of ['trialing', 'paused', 'canceled', 'incomplete_expired']) expect(orgReactivationReadsInvoice({ id: 'sub_1', status }, unfunded)).toBe(false);
    });
  });

  describe('confirm_payment', () => {
    it.each(['incomplete', 'past_due', 'unpaid'])('SEAT-9 (partial) a %s subscription with an open, owing, automatically collected invoice hands back its client secret', (status) => {
      const sub = facts({ status, latestInvoice: payable });
      expect(plan([sub])).toEqual({ kind: 'confirm_payment', subscription: sub, adopted: false, clientSecret: 'pi_123_secret_abc', items: { baseItemId: 'si_base', seatItem: { id: 'si_seat', quantity: 0 } } });
    });

    it('SEAT-1 (partial) a lost-row incomplete subscription awaiting its first payment is adopted and paid, never bought twice', () => {
      expect(plan([facts({ status: 'incomplete', latestInvoice: payable })], null)).toMatchObject({ kind: 'confirm_payment', adopted: true });
    });
  });

  describe('new_checkout', () => {
    it('SEAT-8 (partial) an org with no subscription anywhere starts a paid checkout with no previous generation', () => {
      expect(plan([], null)).toEqual({ kind: 'new_checkout', previousSubscriptionId: null });
    });

    it.each(['canceled', 'incomplete_expired'])('SEAT-9 (partial) an org whose subscription is %s re-subscribes; the new create key follows the newest ended subscription', (status) => {
      const subs = [
        facts({ id: 'sub_old', status: 'canceled', created: 100 }),
        facts({ id: 'sub_new', status, created: 200 }),
      ];
      expect(plan(subs, 'sub_old')).toEqual({ kind: 'new_checkout', previousSubscriptionId: 'sub_new' });
    });

    it('a stored subscription Stripe no longer lists still names the previous generation', () => {
      expect(plan([], 'sub_stored')).toEqual({ kind: 'new_checkout', previousSubscriptionId: 'sub_stored' });
    });
  });

  describe('requires_support — anything PageSpace did not create is never repaired in place', () => {
    it.each(['trialing', 'paused'] as const)('SEAT-9 (partial) a %s subscription (a Stripe-side trial or pause) needs support, even with an open invoice', (status) => {
      expect(plan([facts({ status, latestInvoice: payable })])).toEqual(support(status));
    });

    it.each(['active', 'incomplete', 'past_due', 'unpaid'])('P1: a %s subscription switched to send_invoice collection needs support and never reads as active', (status) => {
      expect(plan([facts({ status, collectionMethod: 'send_invoice', latestInvoice: payable })])).toEqual(support('manual_collection'));
    });

    const unpayable: Array<[string, OrgLatestInvoice | null]> = [
      ['void', { ...payable, status: 'void' }],
      ['uncollectible', { ...payable, status: 'uncollectible' }],
      ['paid', { ...payable, status: 'paid', amountDueCents: 0 }],
      ['draft', { ...payable, status: 'draft' }],
      ['zero-amount', { ...payable, amountDueCents: 0 }],
      ['secret-less', { ...payable, clientSecret: null }],
      ['missing', null],
    ];
    for (const status of ['incomplete', 'past_due', 'unpaid']) {
      it.each(unpayable)(`P2: a ${status} subscription whose latest invoice is %s needs support, never a success with nothing to pay`, (_label, latestInvoice) => {
        expect(plan([facts({ status, latestInvoice })])).toEqual(support('no_payable_invoice'));
      });
    }

    it('an unrecognized price identity (unknown base, missing seat item, extra item, truncated items) needs support', () => {
      for (const items of [
        [{ id: 'si_base', priceId: 'price_unknown', quantity: 1 }, { id: 'si_seat', priceId: 'price_seat', quantity: 0 }],
        [{ id: 'si_base', priceId: 'price_base', quantity: 1 }],
        [...candidate().items, { id: 'si_x', priceId: 'price_x', quantity: 1 }],
      ]) {
        expect(plan([facts({ items })])).toEqual(support('unrecognized_price'));
      }
      expect(plan([facts({ itemsHasMore: true })])).toEqual(support('unrecognized_price'));
    });

    it('zero trust on metadata: a live subscription on the org customer that is not stamped with this org (stamp removed, another org\'s stamp, made by hand) needs support, never a second checkout', () => {
      const stamps: Array<Record<string, string> | null> = [null, {}, { [ORG_ID_METADATA_KEY]: 'org_other' }];
      for (const metadata of stamps) {
        expect(plan([facts({ status: 'past_due', latestInvoice: payable, metadata })])).toEqual(support('unrecognized_subscription'));
        expect(plan([facts({ metadata })], null)).toEqual(support('unrecognized_subscription'));
      }
    });

    it('zero trust on metadata: the stamped subscription plus any other live one on the customer, stamped or not, needs support', () => {
      for (const metadata of [null, { [ORG_ID_METADATA_KEY]: 'org_other' }]) {
        const subs = [facts(), facts({ id: 'sub_extra', created: 200, metadata })];
        expect(plan(subs)).toEqual(support('multiple_live_subscriptions'));
      }
    });

    it('ended subscriptions on the customer, stamped or not, never block checkout and name the previous generation', () => {
      const subs = [facts({ id: 'sub_unstamped', status: 'canceled', created: 300, metadata: null }), facts({ id: 'sub_old', status: 'canceled', created: 100 })];
      expect(plan(subs, null)).toEqual({ kind: 'new_checkout', previousSubscriptionId: 'sub_unstamped' });
    });

    it('a second live subscription stamped with the org needs support, whatever their statuses, and nothing is bought', () => {
      const pairs: Array<[string, string]> = [['active', 'active'], ['active', 'incomplete'], ['past_due', 'trialing'], ['active', 'paused']];
      for (const [a, b] of pairs) {
        const subs = [facts({ id: 'sub_1', status: a, created: 100, latestInvoice: payable }), facts({ id: 'sub_2', status: b, created: 200, latestInvoice: payable })];
        expect(plan(subs)).toEqual(support('multiple_live_subscriptions'));
        expect(plan(subs, null)).toEqual(support('multiple_live_subscriptions'));
      }
    });

    it('a status Stripe adds later is not guessed at', () => {
      expect(plan([facts({ status: 'some_future_status', latestInvoice: payable })])).toEqual(support('unknown_status'));
    });
  });

  it('is deterministic: the order Stripe lists subscriptions in never changes the plan', () => {
    const subs = [facts({ id: 'sub_a', status: 'canceled', created: 100 }), facts({ id: 'sub_b', status: 'canceled', created: 100 })];
    expect(plan(subs, null)).toEqual(plan([...subs].reverse(), null));
  });
});

describe('orgSubscriptionItems — the linkage stored on the org', () => {
  it('SEAT-1 (partial) finds the base item and the seat item with its quantity', () => {
    expect(orgSubscriptionItems(candidate(), PRICES)).toEqual({ baseItemId: 'si_base', seatItem: { id: 'si_seat', quantity: 0 } });
  });

  it('a missing seat item, an unknown item or a subscription without the base price is not the org Business plan PageSpace creates', () => {
    expect(orgSubscriptionItems(candidate({ items: [{ id: 'si_base', priceId: 'price_base', quantity: 1 }] }), PRICES)).toBeNull();
    expect(orgSubscriptionItems(candidate({ items: [...candidate().items, { id: 'si_x', priceId: 'price_x', quantity: 1 }] }), PRICES)).toBeNull();
    expect(orgSubscriptionItems(candidate({ items: [{ id: 'si', priceId: 'price_pro', quantity: 1 }] }), PRICES)).toBeNull();
    expect(orgSubscriptionItems(candidate({ itemsHasMore: true }), PRICES)).toBeNull();
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
