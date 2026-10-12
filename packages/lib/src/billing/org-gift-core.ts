/**
 * org-gift-core — the pure decisions behind an admin gifting an organization, and revoking
 * that gift (Spec SEAT-8, [D-OW-23], [D-OW-30], [D-OW-54]).
 *
 * A gift is applied ON the org's own stored subscription — never a separate one — so the
 * one funding path (wallet-funding-shell applyOrgPoolRefill) sees an invoice whose
 * subscription is the org's and whose subscription metadata says `gift_subscription`, and
 * funds the pool at list price × the included-credit ratio. A gift on any other
 * subscription funds nothing (`gift_not_org_subscription`), which is why this module only
 * ever plans a write to the subscription id read from the database.
 *
 * [D-OW-54] the admin pins the gift's seats: `extraSeats` beyond the Business base. The
 * shell stores the pin (org_subscriptions.giftedExtraSeats) and the seat item is set to it;
 * while it stands, the seat item is held there, auto-add is refused past it, and each gift
 * invoice funds exactly that many seats — never the invoice's seat line, which a gifted
 * Owner could inflate for free with throwaway invites.
 *
 * What a gift writes: on a LAPSED org the subscription's open invoices are voided first (its
 * failed renewal must not keep retrying a charge, or reach dunning, on a gifted period; an
 * ACTIVE org's open renewal is a period it still pays for, so nothing is voided there), then
 * one 100% `forever` coupon and the gift metadata in a single subscription update with
 * no proration. An ACTIVE org keeps the period it already paid for and its next invoice is
 * the first $0 gift invoice. A LAPSED org (past_due, unpaid) has its billing cycle reset to
 * now, so Stripe issues the $0 gift invoice immediately and the lapse lifts at once. An org
 * whose first invoice is still open (`incomplete`) is refused: Stripe expires that
 * subscription after 23 hours whatever is written to it.
 *
 * Resumable: the coupon id and its creation key depend on the subscription alone, and the
 * shell retrieves before it creates, so a gift interrupted between its writes completes on
 * any retry, and a gift revoked and given again reuses its coupon.
 *
 * Stripe is the single source of whether a gift is applied: the shell reads the subscription's
 * gift metadata from Stripe (not the lagging mirror) before it plans. A gift Stripe already
 * holds with the requested seats is COMPLETED (the pin is committed, nothing is written to
 * Stripe again), whichever came first after an ambiguous failure — the retry or the
 * subscription webhook; with any other seat count it is refused (revoke first), so a lapsed org
 * is never re-anchored and billed twice. The webhook mirror reads the same metadata through
 * {@link parseOrgGiftMetadata}.
 *
 * One Stripe key per gift state transition: the subscription update of a gift (subscription,
 * revision, pinned seats) and of a revoke (subscription, revision) is keyed on the stored gift
 * revision, which every gift and revoke bumps under the billing
 * lock. A retry of the SAME transition (the revision did not commit) replays its own request;
 * a later gift or revoke can never be answered with an earlier one's cached response.
 */
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { isLiveOrgSubscriptionStatus, orgStripeIdempotencyKey } from './org-subscription-core';

/** The subscription metadata `type` the funding path recognises as an admin gift. */
export const ORG_GIFT_METADATA_TYPE = 'gift_subscription';

/**
 * The most extra seats an admin gift may pin (D-OW-54). One bound for both doors: the admin
 * route refuses more, and a pin read back from Stripe metadata above it is invalid — so a
 * tampered pin can never size a gift beyond what the audited route could have written.
 */
export const MAX_GIFTED_EXTRA_SEATS = 10_000;

/** What a subscription's metadata says about an admin gift. */
export interface OrgGiftMetadataState {
  /** The metadata says this is a gift (`type: gift_subscription`). */
  typed: boolean;
  /** The pinned gifted extra seats, when the metadata carries a valid one (a non-negative integer). */
  giftedExtraSeats: number | null;
}

/**
 * Parse a Stripe subscription's gift metadata. A gift-typed subscription with a missing or
 * invalid seat pin (not an integer in 0..{@link MAX_GIFTED_EXTRA_SEATS}) reads `{ typed: true, giftedExtraSeats: null }`:
 * the mirror treats it as NOT gifted for capability and reports it, and a new gift is refused
 * until it is revoked.
 */
export function parseOrgGiftMetadata(metadata: Record<string, string> | null | undefined): OrgGiftMetadataState {
  if (metadata?.type !== ORG_GIFT_METADATA_TYPE) return { typed: false, giftedExtraSeats: null };
  const raw = metadata.giftedExtraSeats;
  const seats = typeof raw === 'string' && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
  return { typed: true, giftedExtraSeats: seats !== null && seats <= MAX_GIFTED_EXTRA_SEATS ? seats : null };
}

export type OrgGiftRefusal =
  | 'billing_disabled'
  | 'org_not_found'
  | 'admin_is_member'
  | 'invalid_seat_count'
  | 'no_subscription'
  | 'awaiting_first_payment'
  | 'subscription_not_live'
  | 'already_gifted'
  | 'not_gifted';

/** The stored org subscription, as the shell read it under the billing lock. */
export interface OrgGiftStored {
  stripeSubscriptionId: string;
  stripeSeatItemId: string;
  status: string;
  /** Mirrored from Stripe's subscription metadata. */
  gifted: boolean;
  /** The admin-pinned gifted extra seats, or null. */
  giftedExtraSeats: number | null;
  /** Bumped by every gift and revoke (org_subscriptions.giftRevision). */
  giftRevision: number;
}

/** What the shell read from the database; nothing here comes from the request but the reason and seats. */
export interface OrgGiftFacts {
  orgId: string;
  adminUserId: string;
  reason: string;
  /** Extra seats beyond the Business base the gift covers (D-OW-54). */
  extraSeats: number;
  billingEnabled: boolean;
  /** The org, with the gifting admin's own role in it (null when not a member). */
  org: { adminRole: OrgRole | null } | null;
  stored: OrgGiftStored | null;
  /** The stored subscription's gift metadata as Stripe holds it NOW (null with no subscription). */
  stripeGift: OrgGiftMetadataState | null;
}

export type OrgUngiftFacts = Omit<OrgGiftFacts, 'extraSeats'>;

export interface OrgGiftCouponParams {
  id: string;
  percent_off: 100;
  duration: 'forever';
  name: string;
  metadata: { giftedOrgId: string; stripeSubscriptionId: string };
}

export interface OrgGiftSubscriptionUpdate {
  discounts: [{ coupon: string }];
  /** No admin or reason here: those live in the audit trails, so a retried gift is the same request. */
  metadata: { type: typeof ORG_GIFT_METADATA_TYPE; giftedExtraSeats: string };
  /** The seat item, held at the gifted quantity. */
  items: [{ id: string; quantity: number }];
  proration_behavior: 'none';
  /** Set only for a lapsed org: Stripe invoices the $0 gift now. */
  billing_cycle_anchor?: 'now';
}

/** Removes the gift: '' clears the discounts and each metadata key (Stripe's unset convention). */
export interface OrgUngiftSubscriptionUpdate {
  discounts: '';
  metadata: { type: ''; giftedExtraSeats: '' };
  proration_behavior: 'none';
}

export type OrgGiftPlan =
  | { kind: 'refuse'; reason: OrgGiftRefusal }
  /**
   * Stripe already holds this gift with these seats (an ambiguous failure the webhook or the
   * retry got to first): commit the pin and the revision; write nothing to Stripe.
   */
  | { kind: 'complete'; subscriptionId: string; giftedExtraSeats: number; nextGiftRevision: number; couponId: string }
  | {
      kind: 'gift';
      subscriptionId: string;
      giftedExtraSeats: number;
      /** The gift revision this gift commits. */
      nextGiftRevision: number;
      /** Void the subscription's open invoices before the update: a lapsed org only. */
      voidOpenInvoices: boolean;
      coupon: OrgGiftCouponParams;
      couponKey: string;
      update: OrgGiftSubscriptionUpdate;
      updateKey: string;
      /** The gift is invoiced now (lapsed org) rather than at the next renewal. */
      restoresNow: boolean;
    };

export type OrgUngiftPlan =
  | { kind: 'refuse'; reason: OrgGiftRefusal }
  | { kind: 'ungift'; subscriptionId: string; update: OrgUngiftSubscriptionUpdate; updateKey: string; nextGiftRevision: number };

/** Statuses a lapsed org's subscription has while Stripe still invoices it. */
const LAPSED_INVOICING_STATUSES: ReadonlySet<string> = new Set(['past_due', 'unpaid']);

/** The gift coupon for a subscription: one per subscription, reused across retries and re-gifts. */
export function orgGiftCouponId(stripeSubscriptionId: string): string {
  return `GIFT_ORG_${stripeSubscriptionId}`;
}

/** The idempotency key for voiding one of the org's open invoices as part of a gift. */
export function orgGiftVoidKey(orgId: string, invoiceId: string): string {
  return orgStripeIdempotencyKey(orgId, 'gift.invoice.void', { invoiceId });
}

/**
 * The checks a gift and its revoke share. An admin who belongs to the org in ANY role draws on
 * the pool a gift funds, so membership of any kind refuses (self-dealing, like the personal
 * route's own-account guard).
 */
function refuseCommon(facts: OrgUngiftFacts): OrgGiftRefusal | null {
  if (!facts.billingEnabled) return 'billing_disabled';
  if (!facts.org) return 'org_not_found';
  if (facts.org.adminRole !== null) return 'admin_is_member';
  if (!facts.stored) return 'no_subscription';
  return null;
}

export function planOrgGift(facts: OrgGiftFacts): OrgGiftPlan {
  const common = refuseCommon(facts);
  if (common) return { kind: 'refuse', reason: common };
  if (!Number.isInteger(facts.extraSeats) || facts.extraSeats < 0 || facts.extraSeats > MAX_GIFTED_EXTRA_SEATS) {
    return { kind: 'refuse', reason: 'invalid_seat_count' };
  }
  const stored = facts.stored as OrgGiftStored;
  if (stored.status === 'incomplete') return { kind: 'refuse', reason: 'awaiting_first_payment' };
  const restoresNow = LAPSED_INVOICING_STATUSES.has(stored.status);
  if (!isLiveOrgSubscriptionStatus(stored.status) || (stored.status !== 'active' && !restoresNow)) {
    return { kind: 'refuse', reason: 'subscription_not_live' };
  }
  const subscriptionId = stored.stripeSubscriptionId;
  const inStripe = facts.stripeGift ?? { typed: false, giftedExtraSeats: null };
  if (inStripe.typed) {
    return inStripe.giftedExtraSeats === facts.extraSeats
      ? { kind: 'complete', subscriptionId, giftedExtraSeats: facts.extraSeats, nextGiftRevision: stored.giftRevision + 1, couponId: orgGiftCouponId(subscriptionId) }
      : { kind: 'refuse', reason: 'already_gifted' };
  }

  const coupon: OrgGiftCouponParams = {
    id: orgGiftCouponId(subscriptionId),
    percent_off: 100,
    duration: 'forever',
    name: `Gift for organization ${facts.orgId}`,
    metadata: { giftedOrgId: facts.orgId, stripeSubscriptionId: subscriptionId },
  };
  const update: OrgGiftSubscriptionUpdate = {
    discounts: [{ coupon: coupon.id }],
    metadata: { type: ORG_GIFT_METADATA_TYPE, giftedExtraSeats: String(facts.extraSeats) },
    items: [{ id: stored.stripeSeatItemId, quantity: facts.extraSeats }],
    proration_behavior: 'none',
    ...(restoresNow ? { billing_cycle_anchor: 'now' as const } : {}),
  };
  return {
    kind: 'gift',
    subscriptionId,
    giftedExtraSeats: facts.extraSeats,
    nextGiftRevision: stored.giftRevision + 1,
    voidOpenInvoices: restoresNow,
    coupon,
    couponKey: orgStripeIdempotencyKey(facts.orgId, 'gift.coupon.create', coupon),
    update,
    // Keyed on the transition alone — subscription, gift revision, pinned seats — never the
    // admin or the reason, so a retry after an ambiguous failure (applied in Stripe, reported as
    // an error, rolled back here) replays the one update instead of applying it again.
    updateKey: orgStripeIdempotencyKey(facts.orgId, 'gift.subscription.update', { subscriptionId, giftRevision: stored.giftRevision, giftedExtraSeats: facts.extraSeats }),
    restoresNow,
  };
}

export function planOrgUngift(facts: OrgUngiftFacts): OrgUngiftPlan {
  const common = refuseCommon(facts);
  if (common) return { kind: 'refuse', reason: common };
  const stored = facts.stored as OrgGiftStored;
  if (!facts.stripeGift?.typed && !stored.gifted && stored.giftedExtraSeats === null) return { kind: 'refuse', reason: 'not_gifted' };
  const subscriptionId = stored.stripeSubscriptionId;
  const update: OrgUngiftSubscriptionUpdate = {
    discounts: '',
    metadata: { type: '', giftedExtraSeats: '' },
    proration_behavior: 'none',
  };
  return {
    kind: 'ungift',
    subscriptionId,
    update,
    updateKey: orgStripeIdempotencyKey(facts.orgId, 'gift.subscription.revoke', { subscriptionId, giftRevision: stored.giftRevision, update }),
    nextGiftRevision: stored.giftRevision + 1,
  };
}

/** The HTTP status an admin route answers a refusal with. */
export function orgGiftRefusalStatus(reason: OrgGiftRefusal): 400 | 404 | 409 {
  switch (reason) {
    case 'billing_disabled':
    case 'org_not_found':
      return 404;
    case 'admin_is_member':
    case 'invalid_seat_count':
      return 400;
    case 'no_subscription':
    case 'awaiting_first_payment':
    case 'subscription_not_live':
    case 'already_gifted':
    case 'not_gifted':
      return 409;
  }
}
