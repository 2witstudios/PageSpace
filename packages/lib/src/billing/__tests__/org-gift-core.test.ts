import { describe, it, expect } from 'vitest';
import {
  planOrgGift,
  planOrgUngift,
  orgGiftCouponId,
  orgGiftVoidKey,
  orgGiftRefusalStatus,
  ORG_GIFT_METADATA_TYPE,
  type OrgGiftFacts,
  type OrgGiftRefusal,
  type OrgUngiftFacts,
} from '../org-gift-core';

const stored = (over: Partial<NonNullable<OrgGiftFacts['stored']>> = {}): NonNullable<OrgGiftFacts['stored']> => ({
  stripeSubscriptionId: 'sub_org',
  stripeSeatItemId: 'si_seat',
  status: 'active',
  gifted: false,
  giftedExtraSeats: null,
  giftRevision: 0,
  ...over,
});

const facts = (over: Partial<OrgGiftFacts> = {}): OrgGiftFacts => ({
  orgId: 'org_northwind',
  adminUserId: 'adm_1',
  reason: 'Design partner',
  extraSeats: 2,
  billingEnabled: true,
  org: { adminRole: null },
  stored: stored(),
  ...over,
});

describe('planOrgGift (SEAT-8 admin gift, D-OW-23, D-OW-54)', () => {
  it('SEAT-8 (partial) gifts ON the org\'s own stored subscription: a 100% forever coupon, the gift metadata the funding path reads, and the seat item held at the pinned quantity', () => {
    const plan = planOrgGift(facts());
    expect(plan.kind).toBe('gift');
    if (plan.kind !== 'gift') return;
    expect(plan.subscriptionId).toBe('sub_org');
    expect(plan.giftedExtraSeats).toBe(2);
    expect(plan.coupon).toMatchObject({ id: orgGiftCouponId('sub_org'), percent_off: 100, duration: 'forever' });
    expect(plan.update.discounts).toEqual([{ coupon: plan.coupon.id }]);
    expect(plan.update.metadata).toEqual({ type: ORG_GIFT_METADATA_TYPE, giftedBy: 'adm_1', reason: 'Design partner', giftedExtraSeats: '2' });
    expect(plan.update.items).toEqual([{ id: 'si_seat', quantity: 2 }]);
    expect(ORG_GIFT_METADATA_TYPE).toBe('gift_subscription');
    expect(plan.update.proration_behavior).toBe('none');
  });

  it('D-OW-54 a gift on a LAPSED org voids the subscription\'s open invoices before it is applied', () => {
    for (const status of ['past_due', 'unpaid']) {
      const plan = planOrgGift(facts({ stored: stored({ status }) }));
      expect(plan.kind === 'gift' && plan.voidOpenInvoices, status).toBe(true);
    }
  });

  it('D-OW-54 a gift on an ACTIVE org voids nothing: an issued-but-uncharged renewal is the period the org still pays for', () => {
    const plan = planOrgGift(facts());
    expect(plan.kind === 'gift' && plan.voidOpenInvoices).toBe(false);
  });

  it('D-OW-54 one idempotency key per gift state transition: the same transition retried reuses its key; the same request at a later gift revision gets a new one', () => {
    const first = planOrgGift(facts());
    const retry = planOrgGift(facts());
    const later = planOrgGift(facts({ stored: stored({ giftRevision: 2 }) }));
    if (first.kind !== 'gift' || retry.kind !== 'gift' || later.kind !== 'gift') throw new Error('expected gifts');
    expect(retry.updateKey).toBe(first.updateKey);
    expect(later.updateKey).not.toBe(first.updateKey);
    expect(first.nextGiftRevision).toBe(1);
    expect(later.nextGiftRevision).toBe(3);
    // The coupon is one per subscription, whatever the revision.
    expect(later.couponKey).toBe(first.couponKey);
  });

  it('an active org keeps the period it paid for: the gift starts at renewal (no anchor reset)', () => {
    const plan = planOrgGift(facts());
    expect(plan.kind === 'gift' && plan.update.billing_cycle_anchor).toBeUndefined();
    expect(plan.kind === 'gift' && plan.restoresNow).toBe(false);
  });

  it.each(['past_due', 'unpaid'])('a lapsed (%s) org is invoiced at $0 now, so the gift lifts the lapse at once', (status) => {
    const plan = planOrgGift(facts({ stored: stored({ status }) }));
    expect(plan.kind).toBe('gift');
    if (plan.kind !== 'gift') return;
    expect(plan.update.billing_cycle_anchor).toBe('now');
    expect(plan.restoresNow).toBe(true);
  });

  it('D-OW-54 resumable: the coupon id and its creation key depend only on the subscription, so a retry with another reason or by another admin reuses the same coupon', () => {
    const a = planOrgGift(facts());
    const b = planOrgGift(facts({ reason: 'Retry after a Stripe error', adminUserId: 'adm_2' }));
    const c = planOrgGift(facts({ stored: stored({ stripeSubscriptionId: 'sub_other' }) }));
    if (a.kind !== 'gift' || b.kind !== 'gift' || c.kind !== 'gift') throw new Error('expected gifts');
    expect(b.coupon).toEqual(a.coupon);
    expect(b.couponKey).toBe(a.couponKey);
    expect(a.coupon.id).not.toBe(c.coupon.id);
    expect(a.couponKey).not.toBe(c.couponKey);
    // The update itself is keyed on what it writes: the same request replays, another does not.
    expect(planOrgGift(facts()).kind === 'gift' && (planOrgGift(facts()) as typeof a).updateKey).toBe(a.updateKey);
    expect(b.updateKey).not.toBe(a.updateKey);
  });

  it('void keys are per org and invoice', () => {
    expect(orgGiftVoidKey('org_a', 'in_1')).toBe(orgGiftVoidKey('org_a', 'in_1'));
    expect(orgGiftVoidKey('org_a', 'in_1')).not.toBe(orgGiftVoidKey('org_a', 'in_2'));
  });

  it.each<[string, Partial<OrgGiftFacts>, OrgGiftRefusal]>([
    ['billing off (onprem, tenant)', { billingEnabled: false }, 'billing_disabled'],
    ['no such org', { org: null }, 'org_not_found'],
    ['the admin owns the org', { org: { adminRole: 'OWNER' } }, 'admin_is_member'],
    ['the admin is an org Admin', { org: { adminRole: 'ADMIN' } }, 'admin_is_member'],
    ['the admin is an org Member', { org: { adminRole: 'MEMBER' } }, 'admin_is_member'],
    ['a negative seat count', { extraSeats: -1 }, 'invalid_seat_count'],
    ['a fractional seat count', { extraSeats: 1.5 }, 'invalid_seat_count'],
    ['no subscription stored', { stored: null }, 'no_subscription'],
    ['awaiting its first payment', { stored: stored({ status: 'incomplete' }) }, 'awaiting_first_payment'],
    ['canceled', { stored: stored({ status: 'canceled' }) }, 'subscription_not_live'],
    ['expired', { stored: stored({ status: 'incomplete_expired' }) }, 'subscription_not_live'],
    ['an unverified price', { stored: stored({ status: 'unverified_price' }) }, 'subscription_not_live'],
    ['already gifted (mirrored)', { stored: stored({ gifted: true }) }, 'already_gifted'],
    ['already gifted (pinned)', { stored: stored({ giftedExtraSeats: 3 }) }, 'already_gifted'],
  ])('refuses (fail closed) when %s', (_label, over, reason) => {
    expect(planOrgGift(facts(over))).toEqual({ kind: 'refuse', reason });
  });

  it('maps every refusal to an HTTP status', () => {
    expect(orgGiftRefusalStatus('org_not_found')).toBe(404);
    expect(orgGiftRefusalStatus('billing_disabled')).toBe(404);
    expect(orgGiftRefusalStatus('admin_is_member')).toBe(400);
    expect(orgGiftRefusalStatus('invalid_seat_count')).toBe(400);
    for (const r of ['no_subscription', 'awaiting_first_payment', 'subscription_not_live', 'already_gifted', 'not_gifted'] as const) {
      expect(orgGiftRefusalStatus(r)).toBe(409);
    }
  });
});

const ungift = (over: Partial<OrgUngiftFacts> = {}): OrgUngiftFacts => ({
  orgId: 'org_northwind',
  adminUserId: 'adm_1',
  reason: 'Partnership ended',
  billingEnabled: true,
  org: { adminRole: null },
  stored: stored({ gifted: true, giftedExtraSeats: 2, giftRevision: 1 }),
  ...over,
});

describe('planOrgUngift (SEAT-8 revoke, D-OW-54)', () => {
  it('removes the gift coupon and every gift metadata key from the org\'s own subscription, with no proration: the org pays from its next renewal', () => {
    const plan = planOrgUngift(ungift());
    expect(plan.kind).toBe('ungift');
    if (plan.kind !== 'ungift') return;
    expect(plan.subscriptionId).toBe('sub_org');
    expect(plan.update).toEqual({
      discounts: '',
      metadata: { type: '', giftedBy: '', reason: '', giftedExtraSeats: '' },
      proration_behavior: 'none',
    });
    expect(plan.updateKey).toBe((planOrgUngift(ungift()) as typeof plan).updateKey);
    expect(plan.nextGiftRevision).toBe(2);
  });

  it('D-OW-54 every revoke has its own key: a second revoke (after a re-gift) is never answered with the first one\'s cached response', () => {
    const firstRevoke = planOrgUngift(ungift());
    const secondRevoke = planOrgUngift(ungift({ stored: stored({ gifted: true, giftedExtraSeats: 2, giftRevision: 3 }) }));
    if (firstRevoke.kind !== 'ungift' || secondRevoke.kind !== 'ungift') throw new Error('expected revokes');
    expect(secondRevoke.updateKey).not.toBe(firstRevoke.updateKey);
  });

  it.each<[string, Partial<OrgUngiftFacts>, OrgGiftRefusal]>([
    ['billing off', { billingEnabled: false }, 'billing_disabled'],
    ['no such org', { org: null }, 'org_not_found'],
    ['the admin is a member', { org: { adminRole: 'MEMBER' } }, 'admin_is_member'],
    ['no subscription', { stored: null }, 'no_subscription'],
    ['not gifted', { stored: stored() }, 'not_gifted'],
  ])('refuses when %s', (_label, over, reason) => {
    expect(planOrgUngift(ungift(over))).toEqual({ kind: 'refuse', reason });
  });

  it('a gift that is only mirrored (pinned seats already cleared) can still be revoked', () => {
    expect(planOrgUngift(ungift({ stored: stored({ gifted: true, giftedExtraSeats: null }) })).kind).toBe('ungift');
  });
});
