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
 *   - SEAT-8 as amended by [D-OW-30]: there is no free org tier and NO org trial.
 *     Creating an org asks for a card at checkout: the subscription starts `incomplete`
 *     and its first invoice waits for the client to confirm a payment
 *     ({@link orgPaymentStep}); the pool is funded from that first real payment. A
 *     trial invoice paid $0 and granted $50 of pool credit, which was farmable by
 *     creating orgs over and over.
 *   - SEAT-9 reactivation, [D-OW-44]: {@link planOrgReactivation} decides from Stripe's
 *     current facts. It only repairs states PageSpace itself creates (no subscription, an
 *     ended one, a payment owed on a payable invoice); an active subscription counts only once
 *     its funding is verified or its payment is in (D-OW-30); anything changed outside PageSpace
 *     (a trial, a pause, send_invoice collection, an unpayable invoice, other prices, a
 *     second subscription) is refused for support, never mutated in place.
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
import { orgExtraSeatQuantity } from './org-plan-quote';
import { GIFT_SUBSCRIPTION_METADATA_TYPE, ORG_POOL_FUNDS_GIFTS } from './wallet-funding';

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

/** A-8: the extra-seat item's quantity, from the one client-safe plan-quote module. */
export { orgExtraSeatQuantity };

export type OrgStripeOperation =
  | 'customer.create'
  | 'customer.update'
  | 'subscription.create'
  | 'subscription.cancel'
  | 'seat-quantity.update';

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

/** Statuses after which a Stripe subscription is over and a new one may be created. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

/** Whether the org still HAS this subscription (any status but canceled / incomplete_expired). */
export function isLiveOrgSubscriptionStatus(status: string): boolean {
  return !ENDED_STATUSES.has(status);
}

/** The customer.create request: only what never changes for an org, so a retry is always the same request. */
export interface OrgCustomerCreateParams {
  metadata: Record<string, string>;
}

/** Name and billing email, set on the customer after it exists (they can change between attempts). */
export interface OrgCustomerDetails {
  name: string;
  email?: string;
}

/** SEAT-1: the org's own customer — tagged with the org id, never a userId. */
export function orgCustomerCreateParams(input: { orgId: string }): OrgCustomerCreateParams {
  return { metadata: { [ORG_ID_METADATA_KEY]: input.orgId, kind: ORG_CUSTOMER_KIND } };
}

export function orgCustomerDetails(input: { name: string; billingEmail?: string | null }): OrgCustomerDetails {
  return { name: input.name, ...(input.billingEmail ? { email: input.billingEmail } : {}) };
}

/**
 * The customer.create key depends on the ORG ALONE. A create whose response was lost
 * is replayed by Stripe on every retry, whatever changed meanwhile (the org renamed,
 * the Owner's email changed) — the details are reconciled by an update after the create
 * returns, never by a new key. A key that hashed the details would let a rename during
 * Stripe's search lag create a second customer (review P1-A on #2733).
 */
export function orgCustomerCreateKey(orgId: string): string {
  return orgStripeIdempotencyKey(orgId, 'customer.create', orgCustomerCreateParams({ orgId }));
}

/** The per-org advisory lock key taken by provisioning, seat changes and the org delete. */
export function orgBillingLockKey(orgId: string): string {
  return `org_billing:${orgId}`;
}

export interface OrgBusinessSubscriptionParams {
  customer: string;
  items: [{ price: string; quantity: 1 }, { price: string; quantity: number }];
  metadata: Record<string, string>;
  payment_behavior: 'default_incomplete';
  payment_settings: { save_default_payment_method: 'on_subscription' };
}

/**
 * The Business subscription Stripe is asked for (SEAT-1, SEAT-2, A-8, SEAT-8): the
 * base price once and the extra-seat price at {@link orgExtraSeatQuantity}, on the
 * org's customer, stamped with the org id. There is no trial ([D-OW-30]): the first
 * invoice waits for payment (`default_incomplete`) rather than failing the create for
 * want of a card, and the card the client confirms it with is saved on the
 * subscription for every renewal.
 */
export function orgBusinessSubscriptionParams(input: {
  orgId: string;
  customerId: string;
  seats: number;
  prices: OrgBusinessPrices;
}): OrgBusinessSubscriptionParams {
  return {
    customer: input.customerId,
    items: [
      { price: input.prices.basePriceId, quantity: 1 },
      { price: input.prices.seatPriceId, quantity: orgExtraSeatQuantity(input.seats) },
    ],
    metadata: { [ORG_ID_METADATA_KEY]: input.orgId, kind: ORG_SUBSCRIPTION_KIND },
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
  };
}

/**
 * The subscription.create key: the request AND the subscription generation it follows
 * (the org's previous subscription id, null for the first). A retry of the same attempt
 * replays; a new subscription after an ended one is a new request even when its
 * parameters are identical — otherwise Stripe would replay the dead subscription's
 * create for 24 hours and the org could never re-subscribe (review P1-B on #2733).
 */
export function orgSubscriptionCreateKey(
  orgId: string,
  params: OrgBusinessSubscriptionParams,
  previousSubscriptionId: string | null,
): string {
  return orgStripeIdempotencyKey(orgId, 'subscription.create', { params, previousSubscriptionId });
}

/** A Stripe subscription, narrowed to what adoption and linkage read. */
export interface OrgSubscriptionCandidate {
  id: string;
  status: string;
  /** Unix seconds. */
  created: number;
  metadata: Record<string, string> | null;
  items: ReadonlyArray<{ id: string; priceId: string; quantity: number }>;
  itemsHasMore?: boolean;
}

/** The subscription's latest invoice, narrowed to what paying it (or knowing it was paid) needs. */
export interface OrgLatestInvoice {
  /** Stripe invoice.status: draft | open | paid | uncollectible | void. */
  status: string | null;
  /** Stripe invoice.amount_due, minor units. Read only to know whether anything is owed. */
  amountDueCents: number;
  /** Stripe invoice.amount_paid, minor units. Read only to know whether money (not a $0 invoice) came in. */
  amountPaidCents: number;
  /** invoice.confirmation_secret.client_secret: what the client confirms the card with. */
  clientSecret: string | null;
}

export type OrgPaymentStep = { kind: 'none' } | { kind: 'confirm_payment'; clientSecret: string };

/** Subscription statuses whose open invoice the org can still pay to become (or stay) active. */
const PAYABLE_STATUSES: ReadonlySet<string> = new Set(['incomplete', 'past_due', 'unpaid']);

/** Whether a subscription in `status` can owe a payment the client may still make (only then is its invoice read). */
export function orgSubscriptionMayOwePayment(status: string): boolean {
  return PAYABLE_STATUSES.has(status);
}

/**
 * SEAT-8 / SEAT-9 recovery: what the client must do to pay for the org's subscription.
 * A subscription waiting on its first payment (`incomplete`, a new org or a re-subscribe
 * after a lapse) or behind on one (`past_due`, `unpaid`) whose latest invoice is OPEN
 * and owes something hands the client that invoice's confirmation secret; the client
 * confirms a card with it (Stripe's Payment Element), Stripe pays the invoice, and the
 * webhook mirror lifts the lapse and funds the pool from what was paid. Nothing else
 * ever needs a payment step, and an ended subscription never hands out a secret.
 */
export function orgPaymentStep(input: { subscriptionStatus: string; latestInvoice: OrgLatestInvoice | null }): OrgPaymentStep {
  const invoice = input.latestInvoice;
  if (!orgSubscriptionMayOwePayment(input.subscriptionStatus) || invoice === null) return { kind: 'none' };
  if (invoice.status !== 'open' || !(invoice.amountDueCents > 0) || !invoice.clientSecret) return { kind: 'none' };
  return { kind: 'confirm_payment', clientSecret: invoice.clientSecret };
}

export interface OrgSubscriptionItemLinkage {
  baseItemId: string;
  seatItem: { id: string; quantity: number };
}

/**
 * The verified item identity of the org Business plan PageSpace creates: exactly the base
 * price once and the extra-seat price once, nothing else, every item on one page. Anything
 * else (a missing seat item, an extra price, a truncated item list) is null: never mirrored as
 * the plan, never repaired in place ([D-OW-44]).
 */
export function orgSubscriptionItems(sub: Pick<OrgSubscriptionCandidate, 'items' | 'itemsHasMore'>, prices: OrgBusinessPrices): OrgSubscriptionItemLinkage | null {
  if (sub.itemsHasMore || !prices.basePriceId || !prices.seatPriceId || prices.basePriceId === prices.seatPriceId) return null;
  const bases = sub.items.filter(i => i.priceId === prices.basePriceId);
  const seats = sub.items.filter(i => i.priceId === prices.seatPriceId);
  if (bases.length !== 1 || seats.length !== 1 || sub.items.length !== 2) return null;
  const [base] = bases;
  const [seat] = seats;
  if (base.quantity !== 1 || !base.id || !seat.id || seat.id === base.id || !Number.isSafeInteger(seat.quantity) || seat.quantity < 0) return null;
  return { baseItemId: base.id, seatItem: { id: seat.id, quantity: seat.quantity } };
}

/** A Stripe subscription as the reactivation decision reads it: what Stripe says NOW. */
export interface OrgSubscriptionFacts extends OrgSubscriptionCandidate {
  /** Stripe collection_method: charge_automatically | send_invoice. */
  collectionMethod: string;
  /**
   * Its latest invoice. Read only where {@link orgReactivationReadsInvoice} says the decision
   * needs it; null for every other subscription and when it has none.
   */
  latestInvoice: OrgLatestInvoice | null;
}

/**
 * Whether the reactivation decision reads this subscription's latest invoice: it may owe a
 * payment ({@link orgSubscriptionMayOwePayment}), or it is active without verified funding
 * (only the invoice says whether the payment is already in).
 */
export function orgReactivationReadsInvoice(sub: { id: string; status: string }, fundedSubscriptionIds: ReadonlySet<string>): boolean {
  return orgSubscriptionMayOwePayment(sub.status) || (sub.status === 'active' && !fundedSubscriptionIds.has(sub.id));
}

/**
 * D-OW-30: whether an active, not-yet-funded subscription's latest invoice is funding Stripe
 * already has, which the invoice.paid webhook turns into the org_subscription_funding proof
 * (wallet-funding-shell). Money paid counts; a $0 invoice counts only as a gift on the org's
 * OWN (stored) subscription, the only gift that webhook funds. Anything else never funds.
 */
function orgFundingIsPending(subscription: OrgSubscriptionFacts, ownSubscription: boolean): boolean {
  const invoice = subscription.latestInvoice;
  if (invoice?.status !== 'paid') return false;
  if (invoice.amountPaidCents > 0) return true;
  return ORG_POOL_FUNDS_GIFTS && ownSubscription && subscription.metadata?.type === GIFT_SUBSCRIPTION_METADATA_TYPE;
}

/** Why a reactivation is refused for support: each is a state PageSpace never creates. */
export type OrgReactivationSupportReason =
  | 'multiple_live_subscriptions'
  | 'unrecognized_subscription'
  | 'unrecognized_price'
  | 'manual_collection'
  | 'trialing'
  | 'paused'
  | 'no_payable_invoice'
  /** Active in Stripe with no verified funding and no payment that could fund it (D-OW-30: a $0 invoice never funds). */
  | 'unfunded_active'
  | 'unknown_status';

export type OrgReactivationPlan<S extends OrgSubscriptionFacts = OrgSubscriptionFacts> =
  /** The org's subscription is active and its funding is verified: nothing to pay, nothing to write. */
  | { kind: 'already_active'; subscription: S; adopted: boolean; items: OrgSubscriptionItemLinkage }
  /** Active and paid in Stripe; the invoice.paid webhook has not recorded the proof yet. Nothing to pay, nothing to write. */
  | { kind: 'funding_pending'; subscription: S; adopted: boolean; items: OrgSubscriptionItemLinkage }
  /** The org owes its first or a failed payment on an invoice the client can pay. */
  | { kind: 'confirm_payment'; subscription: S; adopted: boolean; items: OrgSubscriptionItemLinkage; clientSecret: string }
  /** The org has no live subscription: create the paid one, following `previousSubscriptionId`. */
  | { kind: 'new_checkout'; previousSubscriptionId: string | null }
  | { kind: 'requires_support'; reason: OrgReactivationSupportReason };

const newestFirst = (a: OrgSubscriptionCandidate, b: OrgSubscriptionCandidate): number =>
  b.created - a.created || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * [D-OW-44] SEAT-8 / SEAT-9: what (re)activating the org's Business subscription may do, from
 * Stripe's current facts alone. Reactivation only repairs states PageSpace itself creates:
 *
 *   - no live subscription on the org's customer (none ever, or every one ended) →
 *     `new_checkout`, the one write the shell may make, keyed on the newest ended generation;
 *   - exactly one, stamped with this org, with the configured plan items and automatic collection:
 *       active with a verified funding proof (`fundedSubscriptionIds`, org_subscription_funding)
 *       → `already_active`; active, unfunded, whose latest invoice already carries the funding the
 *       invoice.paid webhook records → `funding_pending`; incomplete / past_due / unpaid whose
 *       latest invoice is open, owes something and carries a confirmation secret → `confirm_payment`;
 *   - everything else → `requires_support`: a second live subscription, one not stamped with
 *     this org (zero trust on metadata: a removed stamp never makes a live subscription
 *     disappear, so it can never lead to buying a second), an unrecognized price
 *     identity, send_invoice collection, a Stripe-side trial or pause, a payment owed on an
 *     invoice the client cannot pay (void, uncollectible, paid, draft, missing, no secret), an
 *     active subscription nothing ever funded (a $0 non-gift invoice, an un-gifted 100% coupon:
 *     `unfunded_active`, D-OW-30), or a status this code does not know.
 *
 * `subscriptions` is EVERY subscription on the org's own Stripe customer, plus the stored one
 * if Stripe's listing lacks it: the customer holds only org subscriptions, so nothing on it is
 * filtered out by metadata. `adopted` says the subscription is not the stored one: a create
 * whose row was lost.
 * Pure and deterministic: the order Stripe lists subscriptions in never matters.
 */
export function planOrgReactivation<S extends OrgSubscriptionFacts>(input: {
  orgId: string;
  prices: OrgBusinessPrices;
  storedSubscriptionId: string | null;
  subscriptions: ReadonlyArray<S>;
  /** The org's subscriptions with a verified funding proof (org_subscription_funding). */
  fundedSubscriptionIds: ReadonlySet<string>;
}): OrgReactivationPlan<S> {
  const live = input.subscriptions.filter((s) => isLiveOrgSubscriptionStatus(s.status));
  if (live.length === 0) {
    const [newest] = [...input.subscriptions].sort(newestFirst);
    return { kind: 'new_checkout', previousSubscriptionId: newest?.id ?? input.storedSubscriptionId };
  }
  if (live.length > 1) return { kind: 'requires_support', reason: 'multiple_live_subscriptions' };

  const [subscription] = live;
  if (subscription.metadata?.[ORG_ID_METADATA_KEY] !== input.orgId) return { kind: 'requires_support', reason: 'unrecognized_subscription' };
  const items = orgSubscriptionItems(subscription, input.prices);
  if (!items) return { kind: 'requires_support', reason: 'unrecognized_price' };
  if (subscription.collectionMethod !== 'charge_automatically') return { kind: 'requires_support', reason: 'manual_collection' };
  const adopted = subscription.id !== input.storedSubscriptionId;
  if (subscription.status === 'active') {
    if (input.fundedSubscriptionIds.has(subscription.id)) return { kind: 'already_active', subscription, adopted, items };
    return orgFundingIsPending(subscription, !adopted)
      ? { kind: 'funding_pending', subscription, adopted, items }
      : { kind: 'requires_support', reason: 'unfunded_active' };
  }
  if (subscription.status === 'trialing' || subscription.status === 'paused') return { kind: 'requires_support', reason: subscription.status };
  if (!orgSubscriptionMayOwePayment(subscription.status)) return { kind: 'requires_support', reason: 'unknown_status' };
  const payment = orgPaymentStep({ subscriptionStatus: subscription.status, latestInvoice: subscription.latestInvoice });
  return payment.kind === 'confirm_payment'
    ? { kind: 'confirm_payment', subscription, adopted, items, clientSecret: payment.clientSecret }
    : { kind: 'requires_support', reason: 'no_payable_invoice' };
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
