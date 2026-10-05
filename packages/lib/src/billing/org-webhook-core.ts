/**
 * org-webhook-core — the pure decisions the Stripe webhook makes for ORG billing
 * (Spec SEAT-7, MON-3, A-8). The webhook shell (apps/web …/stripe/webhook) does the IO.
 *
 * WHOSE EVENT IS IT. An org's Stripe customer is its own (SEAT-1, one per org, stored
 * on organizations.stripeCustomerId) and never a person's (users.stripeCustomerId).
 * The customer id is therefore the authority: an event on an org's customer is that
 * org's, and nothing else is. The subscription metadata D1 stamps (kind =
 * 'org_business', pagespace_org_id) is a second, weaker signal used only to REFUSE:
 *   - tagged as an org's but on no org's customer → no effect (it never falls through
 *     to the personal path, so an org invoice can never fund a person);
 *   - on org A's customer but tagged for org B → no effect, logged as an error.
 * An event with neither signal is a person's and takes the existing personal path
 * unchanged — which also finds nobody for a customer that is no user's.
 */
import { ORG_ID_METADATA_KEY, ORG_SUBSCRIPTION_KIND, orgSubscriptionItems, type OrgBusinessPrices } from './org-subscription-core';

export type BillingOwnerRoute =
  | { kind: 'org'; orgId: string }
  | { kind: 'person' }
  | { kind: 'org_unlinked'; taggedOrgId: string | null }
  | { kind: 'org_mismatch'; orgId: string; taggedOrgId: string };

export function routeBillingOwner(input: {
  /** The org whose organizations.stripeCustomerId is the event's customer, or null. */
  customerOrgId: string | null;
  /** The subscription's metadata (or the invoice's snapshot of it). */
  metadata: Record<string, string> | null | undefined;
}): BillingOwnerRoute {
  const taggedOrgId = input.metadata?.[ORG_ID_METADATA_KEY] || null;
  const taggedKind = input.metadata?.kind === ORG_SUBSCRIPTION_KIND;
  if (input.customerOrgId !== null) {
    if (taggedOrgId !== null && taggedOrgId !== input.customerOrgId) {
      return { kind: 'org_mismatch', orgId: input.customerOrgId, taggedOrgId };
    }
    return { kind: 'org', orgId: input.customerOrgId };
  }
  if (taggedKind || taggedOrgId !== null) return { kind: 'org_unlinked', taggedOrgId };
  return { kind: 'person' };
}

/** Structural subset of a Stripe invoice line read for the seat count. */
export interface OrgInvoiceSeatLine {
  quantity?: number | null;
  pricing?: { price_details?: { price?: string | { id?: string | null } | null } | null } | null;
}

/**
 * The extra seats an org invoice billed: the quantity on its extra-seat price line — a
 * COUNT, never an amount (amounts come only from the money model). Sizes the pool of a
 * gift at list price ([D-OW-23]; there is no org trial, [D-OW-30]) from the invoice itself, so an invoice.paid
 * that beats the provisioning commit still funds the seats it billed. With several
 * lines for the seat price (prorations), the largest positive quantity is the period's
 * count. Null when the invoice has no seat line or the seat price is not configured.
 */
export function orgInvoiceExtraSeats(
  lines: ReadonlyArray<OrgInvoiceSeatLine | null | undefined>,
  seatPriceId: string,
): number | null {
  if (!seatPriceId) return null;
  let seats: number | null = null;
  for (const line of lines) {
    const price = line?.pricing?.price_details?.price;
    const priceId = typeof price === 'string' ? price : price?.id ?? null;
    if (priceId !== seatPriceId) continue;
    const quantity = line?.quantity;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 0) continue;
    seats = seats === null ? quantity : Math.max(seats, quantity);
  }
  return seats;
}

export type OrgSubscriptionMirrorPlan = 'apply' | 'ignore_other_subscription' | 'no_row';

/**
 * Whether a subscription fetched from Stripe may be mirrored onto the org's stored row.
 * The webhook never mirrors the EVENT's snapshot: under the org's billing lock it
 * re-reads the subscription from Stripe, so whichever delivery runs last writes the
 * latest state and an out-of-order or late event cannot roll the row back. What it
 * must still refuse is a different subscription: a late event about an ended one the
 * org has since replaced. An org with no row yet is the provisioning path's
 * (ensureOrgBusinessSubscription writes the row under the same lock).
 */
export function planOrgSubscriptionMirror(input: {
  storedSubscriptionId: string | null;
  fetchedSubscriptionId: string;
}): OrgSubscriptionMirrorPlan {
  if (input.storedSubscriptionId === null) return 'no_row';
  return input.storedSubscriptionId === input.fetchedSubscriptionId ? 'apply' : 'ignore_other_subscription';
}

/** The seat linkage org_subscriptions stores, as the mirror compares it. */
export interface StoredOrgSeatLinkage {
  stripeBaseItemId: string;
  stripeSeatItemId: string;
  extraSeatQuantity: number;
  seatRevision: number;
}

export type OrgSeatItemMirrorPatch = Partial<StoredOrgSeatLinkage>;

/**
 * Review 3+4 P2-8 (SEAT-7): the subscription mirror re-reads Stripe, so it refreshes the item
 * ids and the extra-seat quantity from what Stripe says NOW — a seat change made outside the app
 * (the dashboard, a support edit) is no longer left stale (the review saw stored 2 vs Stripe 3).
 * A changed quantity bumps the seat revision, so the next seat change's idempotency key can never
 * be one an earlier change already used. A subscription without the base price is not an org
 * Business subscription and changes nothing; a missing seat item never erases the stored one.
 * Only what differs is in the patch.
 */
export function planOrgSeatItemMirror(input: {
  stored: StoredOrgSeatLinkage;
  items: ReadonlyArray<{ id: string; priceId: string; quantity: number }>;
  prices: OrgBusinessPrices;
}): OrgSeatItemMirrorPatch {
  const linkage = orgSubscriptionItems({ items: input.items }, input.prices);
  if (!linkage) return {};
  const patch: OrgSeatItemMirrorPatch = {};
  if (linkage.baseItemId !== input.stored.stripeBaseItemId) patch.stripeBaseItemId = linkage.baseItemId;
  if (linkage.seatItem) {
    if (linkage.seatItem.id !== input.stored.stripeSeatItemId) patch.stripeSeatItemId = linkage.seatItem.id;
    if (linkage.seatItem.quantity !== input.stored.extraSeatQuantity) {
      patch.extraSeatQuantity = linkage.seatItem.quantity;
      patch.seatRevision = input.stored.seatRevision + 1;
    }
  }
  return patch;
}
