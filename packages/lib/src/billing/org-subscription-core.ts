/**
 * org-subscription-core — the PURE decisions behind an organization's own Stripe
 * customer and Business subscription (Spec SEAT-1, SEAT-2, SEAT-8; decision A-8).
 *
 *   - SEAT-1: an org has its own Stripe customer and subscription, separate from any
 *     member's personal plan. The customer is tagged with the org id, never a userId.
 *   - SEAT-2 / A-8: Business is $50 a month with 5 seats included and $10 per extra
 *     seat, billed as a SECOND subscription item whose quantity is max(0, seats − 5).
 *     The seat item is always present (quantity 0 at 5 or fewer seats), so adding a
 *     6th seat is a quantity change, never a new item.
 *   - SEAT-8: creating the org starts Business with a trial; a trial that ends with no
 *     card on file CANCELS, so there is no free org tier.
 *
 * Money amounts never come from here: the price ids are configuration handed in by
 * the caller, and what a credit is stays in money-model (MON-5). The seat count this
 * module maps is the caller's (SEAT-3's count), and the included-seat number is the
 * one in the tier table.
 *
 * Idempotency: every Stripe write is keyed by {@link orgStripeIdempotencyKey}, derived
 * from the org, the operation and the request itself, so a replayed call is the same
 * request to Stripe and never creates a second customer, subscription or item.
 *
 * INVARIANT: zero I/O. The shell (apps/web/src/lib/org-billing) does the reads, the
 * Stripe calls and the writes.
 */

import { createHash } from 'node:crypto';
import { TIER_PLAN_LIMITS } from './subscription-tiers';

/** The org plan's trial on creation (SEAT-8). The design canvas: "Nothing is charged for 14 days." */
export const ORG_BUSINESS_TRIAL_DAYS = 14;

/** Metadata key stamped on the org's Stripe customer and subscription. */
export const ORG_ID_METADATA_KEY = 'pagespace_org_id';

/**
 * `metadata.kind` on the org Business subscription. The webhook's subscription fork
 * (dedicated-routing) reads `kind`; an org subscription routes on this value.
 */
export const ORG_SUBSCRIPTION_KIND = 'org_business';

/** `metadata.kind` on the org's Stripe customer. */
export const ORG_CUSTOMER_KIND = 'organization';

/** The two configured Stripe prices of the org plan (ids only; amounts are Stripe's and the tier table's). */
export interface OrgBusinessPrices {
  basePriceId: string;
  seatPriceId: string;
}

/**
 * A-8: the extra-seat item's quantity for `seats` seats — max(0, seats − included),
 * with the included count from the tier table (5 for Business). A seat count that is
 * not a non-negative integer is refused: billing never rounds a guess.
 */
export function orgExtraSeatQuantity(seats: number): number {
  if (!Number.isInteger(seats) || seats < 0) {
    throw new RangeError(`seat count must be a non-negative integer, got ${seats}`);
  }
  return Math.max(0, seats - TIER_PLAN_LIMITS.business.includedSeats);
}

export type OrgStripeOperation = 'customer.create' | 'subscription.create' | 'seat-item.create' | 'seat-quantity.update';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/**
 * The idempotency key for one Stripe write on behalf of `orgId`: the org, the
 * operation, and a digest of the request. The same call replayed derives the same
 * key, so Stripe answers it with the first result instead of creating a second
 * object; a different request (another seat count, another customer) is a different
 * key and never collides with Stripe's "same key, different parameters" refusal.
 * Always within Stripe's 255-character limit.
 */
export function orgStripeIdempotencyKey(orgId: string, operation: OrgStripeOperation, params: unknown): string {
  const digest = createHash('sha256').update(stableJson(params)).digest('hex').slice(0, 32);
  const orgPart = orgId.length > 150 ? createHash('sha256').update(orgId).digest('hex') : orgId;
  return `pagespace-org:${orgPart}:${operation}:${digest}`;
}

/** SEAT-8: the trial is for the org's FIRST Business subscription only. */
export function orgTrialDays(input: { hadSubscription: boolean }): number {
  return input.hadSubscription ? 0 : ORG_BUSINESS_TRIAL_DAYS;
}

/** Statuses after which a Stripe subscription is over and a new one may be created. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

/** Whether the org still HAS this subscription (any status but canceled / incomplete_expired). */
export function isLiveOrgSubscriptionStatus(status: string): boolean {
  return !ENDED_STATUSES.has(status);
}

export interface OrgCustomerParams {
  name: string;
  email?: string;
  metadata: Record<string, string>;
}

/** SEAT-1: the org's own customer — named for the org and tagged with its id, never a userId. */
export function orgCustomerParams(input: { orgId: string; name: string; billingEmail?: string | null }): OrgCustomerParams {
  return {
    name: input.name,
    ...(input.billingEmail ? { email: input.billingEmail } : {}),
    metadata: { [ORG_ID_METADATA_KEY]: input.orgId, kind: ORG_CUSTOMER_KIND },
  };
}

export interface OrgBusinessSubscriptionParams {
  customer: string;
  items: [{ price: string; quantity: 1 }, { price: string; quantity: number }];
  metadata: Record<string, string>;
  trial_period_days?: number;
  trial_settings?: { end_behavior: { missing_payment_method: 'cancel' } };
  payment_behavior?: 'default_incomplete';
  payment_settings: { save_default_payment_method: 'on_subscription' };
}

/**
 * The Business subscription Stripe is asked for (SEAT-1, SEAT-2, A-8, SEAT-8): the
 * base price once and the extra-seat price at {@link orgExtraSeatQuantity}, on the
 * org's customer, stamped with the org id. With a trial, a trial that ends with no
 * payment method CANCELS (SEAT-8: a card is required before the trial ends). Without
 * one, the first invoice waits for payment (`default_incomplete`) rather than failing
 * the create for want of a card.
 */
export function orgBusinessSubscriptionParams(input: {
  orgId: string;
  customerId: string;
  seats: number;
  prices: OrgBusinessPrices;
  trialDays: number;
}): OrgBusinessSubscriptionParams {
  const trial = Number.isInteger(input.trialDays) && input.trialDays > 0;
  return {
    customer: input.customerId,
    items: [
      { price: input.prices.basePriceId, quantity: 1 },
      { price: input.prices.seatPriceId, quantity: orgExtraSeatQuantity(input.seats) },
    ],
    metadata: { [ORG_ID_METADATA_KEY]: input.orgId, kind: ORG_SUBSCRIPTION_KIND },
    ...(trial
      ? { trial_period_days: input.trialDays, trial_settings: { end_behavior: { missing_payment_method: 'cancel' as const } } }
      : { payment_behavior: 'default_incomplete' as const }),
    payment_settings: { save_default_payment_method: 'on_subscription' },
  };
}

/** A Stripe subscription, narrowed to what adoption and linkage read. */
export interface OrgSubscriptionCandidate {
  id: string;
  status: string;
  /** Unix seconds. */
  created: number;
  metadata: Record<string, string> | null;
  items: ReadonlyArray<{ id: string; priceId: string; quantity: number }>;
}

/**
 * Recovery: when the database has no subscription for the org but Stripe does (a
 * create that succeeded before its row was written), adopt it instead of creating a
 * second. Only a live subscription stamped with THIS org and carrying the base price
 * qualifies; among several, the oldest, so the choice is deterministic.
 */
export function pickAdoptableOrgSubscription<C extends OrgSubscriptionCandidate>(
  candidates: ReadonlyArray<C>,
  input: { orgId: string; prices: OrgBusinessPrices },
): C | null {
  const matches = candidates
    .filter(
      (s) =>
        isLiveOrgSubscriptionStatus(s.status) &&
        s.metadata?.[ORG_ID_METADATA_KEY] === input.orgId &&
        s.items.some((i) => i.priceId === input.prices.basePriceId),
    )
    .sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return matches[0] ?? null;
}

export interface OrgSubscriptionItemLinkage {
  baseItemId: string;
  seatItem: { id: string; quantity: number } | null;
}

/** The item ids stored on the org; null when the subscription has no base item (not an org Business subscription). */
export function orgSubscriptionItems(sub: OrgSubscriptionCandidate, prices: OrgBusinessPrices): OrgSubscriptionItemLinkage | null {
  const base = sub.items.find((i) => i.priceId === prices.basePriceId);
  if (!base) return null;
  const seat = sub.items.find((i) => i.priceId === prices.seatPriceId);
  return { baseItemId: base.id, seatItem: seat ? { id: seat.id, quantity: seat.quantity } : null };
}

export interface StoredSeatItem {
  seatItemId: string;
  /** The quantity Stripe was last set to. */
  extraSeatQuantity: number;
  /** Bumped on every applied quantity change; part of the idempotency key. */
  seatRevision: number;
}

export type SeatQuantitySyncPlan =
  | { kind: 'noop'; quantity: number }
  | { kind: 'update'; itemId: string; quantity: number; nextRevision: number; idempotencyKey: string };

/**
 * A-8: bring the seat item to max(0, seats − 5). The key carries the stored revision,
 * so replaying THIS change is deduplicated while reaching the same quantity again
 * after another change (0 → 2 → 0 → 2) is a new request Stripe must apply. The
 * proration choice is part of the request, so it is part of the key.
 */
export function planSeatQuantitySync(input: {
  orgId: string;
  stored: StoredSeatItem;
  seats: number;
  prorationBehavior?: 'create_prorations' | 'none';
}): SeatQuantitySyncPlan {
  const quantity = orgExtraSeatQuantity(input.seats);
  if (quantity === input.stored.extraSeatQuantity) return { kind: 'noop', quantity };
  return {
    kind: 'update',
    itemId: input.stored.seatItemId,
    quantity,
    nextRevision: input.stored.seatRevision + 1,
    idempotencyKey: orgStripeIdempotencyKey(input.orgId, 'seat-quantity.update', {
      itemId: input.stored.seatItemId,
      revision: input.stored.seatRevision,
      quantity,
      prorationBehavior: input.prorationBehavior ?? 'create_prorations',
    }),
  };
}
