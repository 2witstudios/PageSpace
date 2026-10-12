/**
 * org-gift-core — the pure decision behind an admin gifting an organization (Spec SEAT-8,
 * [D-OW-23], [D-OW-30]).
 *
 * A gift is applied ON the org's own stored subscription — never a separate one — so the
 * one funding path (wallet-funding-shell applyOrgPoolRefill) sees an invoice whose
 * subscription is the org's and whose subscription metadata says `gift_subscription`, and
 * funds the pool at list price × the included-credit ratio. A gift on any other
 * subscription funds nothing (`gift_not_org_subscription`), which is why this module only
 * ever plans a write to the subscription id read from the database.
 *
 * What a gift writes: a single-use 100% `forever` coupon and the gift metadata, in one
 * subscription update with no proration. An ACTIVE org keeps the period it already paid
 * for and its next invoice is the first $0 gift invoice. A LAPSED org (past_due, unpaid)
 * has its billing cycle reset to now, so Stripe issues the $0 gift invoice immediately and
 * the lapse lifts at once. An org whose first invoice is still open (`incomplete`) is
 * refused: Stripe expires that subscription after 23 hours whatever is written to it, so
 * the gift waits for a subscription Stripe will invoice again.
 */
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { isLiveOrgSubscriptionStatus, orgStripeIdempotencyKey } from './org-subscription-core';

/** The subscription metadata `type` the funding path recognises as an admin gift. */
export const ORG_GIFT_METADATA_TYPE = 'gift_subscription';

export type OrgGiftRefusal =
  | 'billing_disabled'
  | 'org_not_found'
  | 'self_gift'
  | 'no_subscription'
  | 'awaiting_first_payment'
  | 'subscription_not_live'
  | 'already_gifted';

/** What the shell read from the database; nothing here comes from the request but the reason. */
export interface OrgGiftFacts {
  orgId: string;
  adminUserId: string;
  reason: string;
  billingEnabled: boolean;
  /** The org, with the gifting admin's own role in it (null when not a member). */
  org: { adminRole: OrgRole | null } | null;
  stored: { stripeSubscriptionId: string; status: string; gifted: boolean } | null;
}

export interface OrgGiftCouponParams {
  id: string;
  percent_off: 100;
  duration: 'forever';
  max_redemptions: 1;
  name: string;
  metadata: { giftedOrgId: string; giftedBy: string; reason: string };
}

export interface OrgGiftSubscriptionUpdate {
  discounts: [{ coupon: string }];
  metadata: { type: typeof ORG_GIFT_METADATA_TYPE; giftedBy: string; reason: string };
  proration_behavior: 'none';
  /** Set only for a lapsed org: Stripe invoices the $0 gift now. */
  billing_cycle_anchor?: 'now';
}

export type OrgGiftPlan =
  | { kind: 'refuse'; reason: OrgGiftRefusal }
  | {
      kind: 'gift';
      subscriptionId: string;
      coupon: OrgGiftCouponParams;
      couponKey: string;
      update: OrgGiftSubscriptionUpdate;
      updateKey: string;
      /** The gift is invoiced now (lapsed org) rather than at the next renewal. */
      restoresNow: boolean;
    };

/** Statuses a lapsed org's subscription has while Stripe still invoices it. */
const LAPSED_INVOICING_STATUSES: ReadonlySet<string> = new Set(['past_due', 'unpaid']);

export function planOrgGift(facts: OrgGiftFacts): OrgGiftPlan {
  if (!facts.billingEnabled) return { kind: 'refuse', reason: 'billing_disabled' };
  if (!facts.org) return { kind: 'refuse', reason: 'org_not_found' };
  if (facts.org.adminRole === 'OWNER') return { kind: 'refuse', reason: 'self_gift' };
  const stored = facts.stored;
  if (!stored) return { kind: 'refuse', reason: 'no_subscription' };
  if (stored.status === 'incomplete') return { kind: 'refuse', reason: 'awaiting_first_payment' };
  const restoresNow = LAPSED_INVOICING_STATUSES.has(stored.status);
  if (!isLiveOrgSubscriptionStatus(stored.status) || (stored.status !== 'active' && !restoresNow)) {
    return { kind: 'refuse', reason: 'subscription_not_live' };
  }
  if (stored.gifted) return { kind: 'refuse', reason: 'already_gifted' };

  const subscriptionId = stored.stripeSubscriptionId;
  const coupon: OrgGiftCouponParams = {
    id: `GIFT_ORG_${subscriptionId}`,
    percent_off: 100,
    duration: 'forever',
    max_redemptions: 1,
    name: `Gift for organization ${facts.orgId}`,
    metadata: { giftedOrgId: facts.orgId, giftedBy: facts.adminUserId, reason: facts.reason },
  };
  const update: OrgGiftSubscriptionUpdate = {
    discounts: [{ coupon: coupon.id }],
    metadata: { type: ORG_GIFT_METADATA_TYPE, giftedBy: facts.adminUserId, reason: facts.reason },
    proration_behavior: 'none',
    ...(restoresNow ? { billing_cycle_anchor: 'now' as const } : {}),
  };
  return {
    kind: 'gift',
    subscriptionId,
    coupon,
    couponKey: orgStripeIdempotencyKey(facts.orgId, 'gift.coupon.create', coupon),
    update,
    updateKey: orgStripeIdempotencyKey(facts.orgId, 'gift.subscription.update', { subscriptionId, update }),
    restoresNow,
  };
}

/** The HTTP status an admin route answers a refusal with. */
export function orgGiftRefusalStatus(reason: OrgGiftRefusal): 400 | 404 | 409 {
  switch (reason) {
    case 'billing_disabled':
    case 'org_not_found':
      return 404;
    case 'self_gift':
      return 400;
    case 'no_subscription':
    case 'awaiting_first_payment':
    case 'subscription_not_live':
    case 'already_gifted':
      return 409;
  }
}
