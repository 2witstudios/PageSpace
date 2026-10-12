import { describe, it, expect } from 'vitest';
import { planOrgGift, orgGiftRefusalStatus, ORG_GIFT_METADATA_TYPE, type OrgGiftFacts } from '../org-gift-core';

const facts = (over: Partial<OrgGiftFacts> = {}): OrgGiftFacts => ({
  orgId: 'org_northwind',
  adminUserId: 'adm_1',
  reason: 'Design partner',
  billingEnabled: true,
  org: { adminRole: null },
  stored: { stripeSubscriptionId: 'sub_org', status: 'active', gifted: false },
  ...over,
});

describe('planOrgGift (SEAT-8 admin gift, D-OW-23)', () => {
  it('SEAT-8 (partial) gifts ON the org\'s own stored subscription: a single-use 100% forever coupon and the gift metadata the funding path reads', () => {
    const plan = planOrgGift(facts());
    expect(plan.kind).toBe('gift');
    if (plan.kind !== 'gift') return;
    expect(plan.subscriptionId).toBe('sub_org');
    expect(plan.coupon).toMatchObject({ percent_off: 100, duration: 'forever', max_redemptions: 1 });
    expect(plan.coupon.metadata).toEqual({ giftedOrgId: 'org_northwind', giftedBy: 'adm_1', reason: 'Design partner' });
    expect(plan.update.discounts).toEqual([{ coupon: plan.coupon.id }]);
    expect(plan.update.metadata).toEqual({ type: ORG_GIFT_METADATA_TYPE, giftedBy: 'adm_1', reason: 'Design partner' });
    expect(ORG_GIFT_METADATA_TYPE).toBe('gift_subscription');
    expect(plan.update.proration_behavior).toBe('none');
  });

  it('an active org keeps the period it paid for: the gift starts at renewal (no anchor reset)', () => {
    const plan = planOrgGift(facts());
    expect(plan.kind === 'gift' && plan.update.billing_cycle_anchor).toBeUndefined();
    expect(plan.kind === 'gift' && plan.restoresNow).toBe(false);
  });

  it.each(['past_due', 'unpaid'])('a lapsed (%s) org is invoiced at $0 now, so the gift lifts the lapse at once', (status) => {
    const plan = planOrgGift(facts({ stored: { stripeSubscriptionId: 'sub_org', status, gifted: false } }));
    expect(plan.kind).toBe('gift');
    if (plan.kind !== 'gift') return;
    expect(plan.update.billing_cycle_anchor).toBe('now');
    expect(plan.restoresNow).toBe(true);
  });

  it('same request → same idempotency keys; another subscription → different keys', () => {
    const a = planOrgGift(facts());
    const b = planOrgGift(facts());
    const c = planOrgGift(facts({ stored: { stripeSubscriptionId: 'sub_other', status: 'active', gifted: false } }));
    if (a.kind !== 'gift' || b.kind !== 'gift' || c.kind !== 'gift') throw new Error('expected gifts');
    expect([a.couponKey, a.updateKey]).toEqual([b.couponKey, b.updateKey]);
    expect(a.couponKey).not.toBe(c.couponKey);
    expect(a.updateKey).not.toBe(c.updateKey);
    expect(a.coupon.id).not.toBe(c.coupon.id);
  });

  it.each<[string, Partial<OrgGiftFacts>, string]>([
    ['billing off (onprem, tenant)', { billingEnabled: false }, 'billing_disabled'],
    ['no such org', { org: null }, 'org_not_found'],
    ['the admin owns the org (self-dealing)', { org: { adminRole: 'OWNER' } }, 'self_gift'],
    ['no subscription stored', { stored: null }, 'no_subscription'],
    ['awaiting its first payment', { stored: { stripeSubscriptionId: 'sub_org', status: 'incomplete', gifted: false } }, 'awaiting_first_payment'],
    ['canceled', { stored: { stripeSubscriptionId: 'sub_org', status: 'canceled', gifted: false } }, 'subscription_not_live'],
    ['expired', { stored: { stripeSubscriptionId: 'sub_org', status: 'incomplete_expired', gifted: false } }, 'subscription_not_live'],
    ['an unverified price', { stored: { stripeSubscriptionId: 'sub_org', status: 'unverified_price', gifted: false } }, 'subscription_not_live'],
    ['already gifted', { stored: { stripeSubscriptionId: 'sub_org', status: 'active', gifted: true } }, 'already_gifted'],
  ])('refuses (fail closed) when %s', (_label, over, reason) => {
    expect(planOrgGift(facts(over))).toEqual({ kind: 'refuse', reason });
  });

  it('maps every refusal to an HTTP status', () => {
    expect(orgGiftRefusalStatus('org_not_found')).toBe(404);
    expect(orgGiftRefusalStatus('billing_disabled')).toBe(404);
    expect(orgGiftRefusalStatus('self_gift')).toBe(400);
    for (const r of ['no_subscription', 'awaiting_first_payment', 'subscription_not_live', 'already_gifted'] as const) {
      expect(orgGiftRefusalStatus(r)).toBe(409);
    }
  });
});
