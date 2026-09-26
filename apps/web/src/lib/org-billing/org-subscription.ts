/**
 * The org's own Stripe customer and Business subscription (Spec SEAT-1, SEAT-2,
 * SEAT-8; decision A-8) — the IO shell around @pagespace/lib/billing/org-subscription-core.
 *
 * GUARANTEES
 *   - One customer per org, one live Business subscription per org, under concurrent
 *     and replayed calls. Three layers, each sufficient on its own for its window:
 *       1. a per-org advisory lock serializes every provisioning step, and the stored
 *          linkage is read under it, so a second caller sees the first caller's result;
 *       2. every Stripe write carries an idempotency key derived from the org, the
 *          operation and the request, so a write whose RESPONSE was lost is replayed
 *          by Stripe (24 hours) instead of executed twice;
 *       3. before creating, Stripe is asked what already exists for the org (customer
 *          search by org id; the customer's subscriptions), so an object Stripe made
 *          but the database never recorded is adopted even after the key window.
 *   - The customer id commits on its own before the subscription is attempted, so a
 *     subscription failure never loses the customer.
 *
 * FAILURE: a Stripe error or outage throws out of the locked transaction, which rolls
 * back only that step's write. What committed before it stays (the customer id); what
 * did not is simply absent (no org_subscriptions row). Nothing is written in a
 * "pending" state, so there is no half-provisioned row to repair: the next call starts
 * from what is stored and recovers through layers 2 and 3 above.
 *
 * Money: the price ids are configuration (stripe-config `orgPriceIds`); no amount is
 * read from Stripe here. The pool refill on invoice.paid is the existing
 * applyOrgPoolRefill path (wallet-funding-shell), found by organizations.stripeCustomerId.
 */
import type Stripe from 'stripe';
import { db } from '@pagespace/db/db';
import { eq, and, isNull, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgSubscriptions, type OrgSubscription } from '@pagespace/db/schema/organizations';
import { countOrgSeats } from '@pagespace/lib/organizations/repository';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { stripe as appStripe } from '@/lib/stripe';
import { stripeConfig } from '@/lib/stripe-config';
import {
  ORG_ID_METADATA_KEY,
  isLiveOrgSubscriptionStatus,
  orgBusinessSubscriptionParams,
  orgCustomerParams,
  orgStripeIdempotencyKey,
  orgSubscriptionItems,
  orgTrialDays,
  pickAdoptableOrgSubscription,
  planSeatQuantitySync,
  type OrgBusinessPrices,
  type OrgBusinessSubscriptionParams,
  type OrgCustomerParams,
  type OrgSubscriptionCandidate,
} from '@pagespace/lib/billing/org-subscription-core';

/** A Stripe subscription as the shell reads it. Unix seconds throughout. */
export interface OrgStripeSubscription extends OrgSubscriptionCandidate {
  customerId: string;
  trialEnd: number | null;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

export type SeatProrationBehavior = 'create_prorations' | 'none';

/** The Stripe operations the shell performs — narrow, so tests supply an in-memory Stripe. */
export interface OrgBillingStripe {
  createCustomer(params: OrgCustomerParams, idempotencyKey: string): Promise<{ id: string }>;
  findCustomerByOrgId(orgId: string): Promise<string | null>;
  createSubscription(params: OrgBusinessSubscriptionParams, idempotencyKey: string): Promise<OrgStripeSubscription>;
  listCustomerSubscriptions(customerId: string): Promise<OrgStripeSubscription[]>;
  createSubscriptionItem(
    params: { subscriptionId: string; priceId: string; quantity: number },
    idempotencyKey: string,
  ): Promise<{ id: string; quantity: number }>;
  updateSubscriptionItemQuantity(
    params: { itemId: string; quantity: number; prorationBehavior: SeatProrationBehavior },
    idempotencyKey: string,
  ): Promise<{ id: string; quantity: number }>;
}

export interface OrgBillingDeps {
  stripe: OrgBillingStripe;
  prices: () => OrgBusinessPrices;
  /** SEAT-3's count: accepted members plus live pending invites. */
  countSeats: (orgId: string) => Promise<number>;
}

export type OrgBillingErrorCode = 'org_not_found' | 'prices_not_configured' | 'not_an_org_business_subscription';

export class OrgBillingError extends Error {
  constructor(
    readonly code: OrgBillingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OrgBillingError';
  }
}

/** The linkage stored on the org, as callers (routes, D2 seat accounting, D3 webhooks) read it. */
export interface OrgSubscriptionLinkage {
  orgId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripeBaseItemId: string;
  stripeSeatItemId: string;
  extraSeatQuantity: number;
  status: string;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
}

export type EnsureOrgSubscriptionResult = {
  /** created: a new Stripe subscription; adopted: one Stripe already had; existing: already stored. */
  kind: 'created' | 'adopted' | 'existing';
  linkage: OrgSubscriptionLinkage;
};

export type SeatSyncResult = { kind: 'updated' | 'noop'; quantity: number } | { kind: 'no_subscription' };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Serializes every billing step for one org, across processes. Held until the transaction ends. */
async function lockOrgBilling(tx: Tx, orgId: string): Promise<void> {
  const key = `org_billing:${orgId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

function configuredPrices(deps: OrgBillingDeps): OrgBusinessPrices {
  const prices = deps.prices();
  if (!prices.basePriceId || !prices.seatPriceId) {
    throw new OrgBillingError('prices_not_configured', 'The org Business prices are not configured for this Stripe mode');
  }
  return prices;
}

const fromUnix = (s: number | null): Date | null => (s === null ? null : new Date(s * 1000));

function toLinkage(row: OrgSubscription, stripeCustomerId: string): OrgSubscriptionLinkage {
  return {
    orgId: row.orgId,
    stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    stripeBaseItemId: row.stripeBaseItemId,
    stripeSeatItemId: row.stripeSeatItemId,
    extraSeatQuantity: row.extraSeatQuantity,
    status: row.status,
    trialEnd: row.trialEnd,
    currentPeriodEnd: row.currentPeriodEnd,
  };
}

/**
 * SEAT-1: the org's own Stripe customer — found or created, never two. The id commits
 * on its own, before any subscription is attempted. `created` is false when the
 * customer was already stored or was found in Stripe.
 */
export async function ensureOrgStripeCustomer(
  orgId: string,
  deps: OrgBillingDeps = defaultOrgBillingDeps(),
): Promise<{ customerId: string; created: boolean }> {
  return db.transaction(async (tx) => {
    await lockOrgBilling(tx, orgId);
    const [org] = await tx
      .select({ name: organizations.name, ownerId: organizations.ownerId, stripeCustomerId: organizations.stripeCustomerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) throw new OrgBillingError('org_not_found', `Organization ${orgId} not found`);
    if (org.stripeCustomerId) return { customerId: org.stripeCustomerId, created: false };

    let customerId = await deps.stripe.findCustomerByOrgId(orgId);
    const created = customerId === null;
    if (customerId === null) {
      const [owner] = await tx.select({ email: users.email }).from(users).where(eq(users.id, org.ownerId)).limit(1);
      const params = orgCustomerParams({ orgId, name: org.name, billingEmail: owner?.email ?? null });
      const customer = await deps.stripe.createCustomer(params, orgStripeIdempotencyKey(orgId, 'customer.create', params));
      customerId = customer.id;
    }
    await tx
      .update(organizations)
      .set({ stripeCustomerId: customerId })
      .where(and(eq(organizations.id, orgId), isNull(organizations.stripeCustomerId)));
    loggers.api.info('org stripe customer linked', { orgId, customerId, created });
    return { customerId, created };
  });
}

/** Write (insert or replace) the org's subscription row and mirror the id on the org, in one transaction. */
async function storeSubscription(
  tx: Tx,
  orgId: string,
  sub: OrgStripeSubscription,
  prices: OrgBusinessPrices,
  seatItem: { id: string; quantity: number },
  baseItemId: string,
): Promise<OrgSubscription> {
  const values = {
    stripeSubscriptionId: sub.id,
    stripeBasePriceId: prices.basePriceId,
    stripeBaseItemId: baseItemId,
    stripeSeatPriceId: prices.seatPriceId,
    stripeSeatItemId: seatItem.id,
    extraSeatQuantity: seatItem.quantity,
    status: sub.status,
    trialEnd: fromUnix(sub.trialEnd),
    currentPeriodStart: fromUnix(sub.currentPeriodStart),
    currentPeriodEnd: fromUnix(sub.currentPeriodEnd),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
  const [row] = await tx
    .insert(orgSubscriptions)
    .values({ orgId, ...values })
    .onConflictDoUpdate({ target: orgSubscriptions.orgId, set: values })
    .returning();
  await tx.update(organizations).set({ stripeSubscriptionId: sub.id }).where(eq(organizations.id, orgId));
  return row;
}

/**
 * SEAT-1, SEAT-8, A-8: the org's Business subscription — the base price plus the
 * extra-seat item at max(0, seats − 5), with the trial on the org's first
 * subscription. Idempotent: an org that already has a live subscription gets it back
 * without a Stripe call; one Stripe has but the database lost is adopted.
 */
export async function ensureOrgBusinessSubscription(
  orgId: string,
  deps: OrgBillingDeps = defaultOrgBillingDeps(),
): Promise<EnsureOrgSubscriptionResult> {
  const prices = configuredPrices(deps);
  const { customerId } = await ensureOrgStripeCustomer(orgId, deps);

  return db.transaction(async (tx) => {
    await lockOrgBilling(tx, orgId);
    const [stored] = await tx.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId)).limit(1);
    if (stored && isLiveOrgSubscriptionStatus(stored.status)) {
      return { kind: 'existing' as const, linkage: toLinkage(stored, customerId) };
    }

    const existing = pickAdoptableOrgSubscription(await deps.stripe.listCustomerSubscriptions(customerId), { orgId, prices });
    let sub: OrgStripeSubscription;
    let kind: 'created' | 'adopted';
    if (existing) {
      sub = existing;
      kind = 'adopted';
    } else {
      const seats = await deps.countSeats(orgId);
      const params = orgBusinessSubscriptionParams({
        orgId,
        customerId,
        seats,
        prices,
        trialDays: orgTrialDays({ hadSubscription: stored !== undefined }),
      });
      sub = await deps.stripe.createSubscription(params, orgStripeIdempotencyKey(orgId, 'subscription.create', params));
      kind = 'created';
    }

    const items = orgSubscriptionItems(sub, prices);
    if (!items) {
      throw new OrgBillingError('not_an_org_business_subscription', `Subscription ${sub.id} has no Business base item`);
    }
    // An adopted subscription made outside this path may lack the seat item; add it at 0.
    const seatItem =
      items.seatItem ??
      (await deps.stripe.createSubscriptionItem(
        { subscriptionId: sub.id, priceId: prices.seatPriceId, quantity: 0 },
        orgStripeIdempotencyKey(orgId, 'seat-item.create', { subscriptionId: sub.id, priceId: prices.seatPriceId }),
      ));

    const row = await storeSubscription(tx, orgId, sub, prices, seatItem, items.baseItemId);
    loggers.api.info('org business subscription linked', { orgId, subscriptionId: sub.id, kind, status: sub.status });
    return { kind, linkage: toLinkage(row, customerId) };
  });
}

/**
 * A-8: set the extra-seat quantity to max(0, seats − 5) for `seats` seats. Seat
 * accounting (SEAT-3..5) decides the count and when to call; raising defaults to a
 * prorated change (SEAT-4), and a caller freeing seats at period end passes
 * `prorationBehavior: 'none'` (SEAT-5). A replay of the same change is a no-op.
 */
export async function syncOrgSeatQuantity(
  orgId: string,
  seats: number,
  opts: { prorationBehavior?: SeatProrationBehavior } = {},
  deps: OrgBillingDeps = defaultOrgBillingDeps(),
): Promise<SeatSyncResult> {
  const prorationBehavior = opts.prorationBehavior ?? 'create_prorations';
  return db.transaction(async (tx) => {
    await lockOrgBilling(tx, orgId);
    const [stored] = await tx.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId)).limit(1);
    if (!stored || !isLiveOrgSubscriptionStatus(stored.status)) return { kind: 'no_subscription' as const };

    const plan = planSeatQuantitySync({
      orgId,
      stored: { seatItemId: stored.stripeSeatItemId, extraSeatQuantity: stored.extraSeatQuantity, seatRevision: stored.seatRevision },
      seats,
      prorationBehavior,
    });
    if (plan.kind === 'noop') return { kind: 'noop' as const, quantity: plan.quantity };

    const item = await deps.stripe.updateSubscriptionItemQuantity(
      { itemId: plan.itemId, quantity: plan.quantity, prorationBehavior },
      plan.idempotencyKey,
    );
    await tx
      .update(orgSubscriptions)
      .set({ extraSeatQuantity: item.quantity, seatRevision: plan.nextRevision })
      .where(eq(orgSubscriptions.orgId, orgId));
    loggers.api.info('org extra-seat quantity updated', { orgId, quantity: item.quantity, seats });
    return { kind: 'updated' as const, quantity: item.quantity };
  });
}

// ---------------------------------------------------------------------------
// The real Stripe
// ---------------------------------------------------------------------------

function toOrgStripeSubscription(sub: Stripe.Subscription): OrgStripeSubscription {
  const items = sub.items.data;
  // API 2025-08-27+: the billing period lives on the items; the base item's is the subscription's.
  const periodItem = items[0] as (Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number }) | undefined;
  return {
    id: sub.id,
    customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    status: sub.status,
    created: sub.created,
    metadata: sub.metadata ?? null,
    items: items.map((i) => ({ id: i.id, priceId: i.price.id, quantity: i.quantity ?? 0 })),
    trialEnd: sub.trial_end ?? null,
    currentPeriodStart: periodItem?.current_period_start ?? null,
    currentPeriodEnd: periodItem?.current_period_end ?? null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  };
}

/** Search query for the org's customer; org ids are cuids, quotes escaped regardless. */
function orgCustomerSearchQuery(orgId: string): string {
  return `metadata['${ORG_ID_METADATA_KEY}']:'${orgId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** The shell's Stripe operations over a real Stripe client. */
export function stripeOrgBilling(client: Stripe): OrgBillingStripe {
  return {
    async createCustomer(params, idempotencyKey) {
      const customer = await client.customers.create(params, { idempotencyKey });
      return { id: customer.id };
    },
    async findCustomerByOrgId(orgId) {
      const found = await client.customers.search({ query: orgCustomerSearchQuery(orgId), limit: 10 });
      const oldest = [...found.data].sort((a, b) => a.created - b.created)[0];
      return oldest?.id ?? null;
    },
    async createSubscription(params, idempotencyKey) {
      return toOrgStripeSubscription(await client.subscriptions.create(params, { idempotencyKey }));
    },
    async listCustomerSubscriptions(customerId) {
      const subs: OrgStripeSubscription[] = [];
      for await (const sub of client.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })) {
        subs.push(toOrgStripeSubscription(sub));
      }
      return subs;
    },
    async createSubscriptionItem(params, idempotencyKey) {
      const item = await client.subscriptionItems.create(
        { subscription: params.subscriptionId, price: params.priceId, quantity: params.quantity, proration_behavior: 'none' },
        { idempotencyKey },
      );
      return { id: item.id, quantity: item.quantity ?? 0 };
    },
    async updateSubscriptionItemQuantity(params, idempotencyKey) {
      const item = await client.subscriptionItems.update(
        params.itemId,
        { quantity: params.quantity, proration_behavior: params.prorationBehavior },
        { idempotencyKey },
      );
      return { id: item.id, quantity: item.quantity ?? 0 };
    },
  };
}

/** Production wiring: the app's Stripe client, the configured org prices, SEAT-3's seat count. */
export function defaultOrgBillingDeps(): OrgBillingDeps {
  // The app client is a lazy proxy: no key is read until the first real Stripe call.
  return {
    stripe: stripeOrgBilling(appStripe),
    prices: () => ({ basePriceId: stripeConfig.orgPriceIds.businessBase, seatPriceId: stripeConfig.orgPriceIds.extraSeat }),
    countSeats: countOrgSeats,
  };
}
