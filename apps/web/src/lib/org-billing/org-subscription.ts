/**
 * The org's own Stripe customer and Business subscription (Spec SEAT-1, SEAT-2,
 * SEAT-8; decision A-8) — the IO shell around @pagespace/lib/billing/org-subscription-core.
 *
 * GUARANTEES
 *   - One customer per org, one live Business subscription per org, under concurrent
 *     and replayed calls. Three layers, each sufficient on its own for its window:
 *       1. a per-org advisory lock serializes every provisioning step, and the stored
 *          linkage is read under it, so a second caller sees the first caller's result;
 *       2. every Stripe write carries an idempotency key derived from the org and the
 *          operation, so a write whose RESPONSE was lost is replayed by Stripe (24
 *          hours) instead of executed twice. customer.create is keyed on the org ALONE
 *          (its details are set by a separate update), so a rename between attempts
 *          still replays the first create; subscription.create is keyed on the request
 *          AND the previous subscription id, so a new subscription after an ended one
 *          is never a replay of the dead one;
 *       3. before creating, Stripe is asked what already exists for the org (customer
 *          search by org id; the customer's subscriptions), so an object Stripe made
 *          but the database never recorded is adopted even after the key window.
 *   - The customer id commits on its own before the subscription is attempted, so a
 *     subscription failure never loses the customer.
 *   - A stored subscription is re-read from Stripe before it is reported, so one Stripe
 *     ended (an unpaid first invoice expired, a cancel) is seen as ended even before the
 *     webhook mirror (D3) updates the row, and the org can subscribe again.
 *   - PAYING ([D-OW-30], review 3+4 P1-1): there is no org trial. A new subscription —
 *     at creation, or a re-subscribe after a lapse — starts `incomplete` with its first
 *     invoice open, and {@link provisionOrgSubscription} hands the client that invoice's
 *     confirmation secret ({@link orgPaymentStep}). The client confirms a card with it
 *     (Stripe's Payment Element); Stripe pays the invoice and the webhook mirror lifts the
 *     lapse and funds the pool from what was paid. No out-of-band step. The billing portal
 *     and the invoice list open on the ORG's customer, never a person's.
 *   - The org delete takes the same lock (packages/lib deletion.ts), so provisioning and
 *     a delete never interleave: provisioning re-checks the org under the lock.
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
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { stripe as appStripe } from '@/lib/stripe';
import { stripeConfig } from '@/lib/stripe-config';
import {
  ORG_ID_METADATA_KEY,
  isLiveOrgSubscriptionStatus,
  orgBillingLockKey,
  orgBusinessSubscriptionParams,
  orgCustomerCreateKey,
  orgCustomerCreateParams,
  orgCustomerDetails,
  orgExtraSeatQuantity,
  orgStripeIdempotencyKey,
  orgSubscriptionCreateKey,
  orgSubscriptionHistory,
  orgSubscriptionItems,
  orgPaymentStep,
  orgSubscriptionMayOwePayment,
  pickAdoptableOrgSubscription,
  planSeatQuantitySync,
  type OrgBusinessPrices,
  type OrgBusinessSubscriptionParams,
  type OrgCustomerCreateParams,
  type OrgCustomerDetails,
  type OrgLatestInvoice,
  type OrgPaymentStep,
  type OrgSubscriptionCandidate,
} from '@pagespace/lib/billing/org-subscription-core';
import { recordOrgAuditEventAfterCommit } from '@pagespace/lib/audit/org-audit';

/** A Stripe subscription as the shell reads it. Unix seconds throughout. */
export interface OrgStripeSubscription extends OrgSubscriptionCandidate {
  customerId: string;
  trialEnd: number | null;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

export type SeatProrationBehavior = 'create_prorations' | 'none';

/** One org invoice as Owner and Admins see it (SEAT-6): Stripe's record of what was billed, never a Stripe customer or subscription id. */
export interface OrgInvoiceSummary {
  id: string;
  number: string | null;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: string;
  periodStart: string | null;
  periodEnd: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

/** The Stripe operations the shell performs — narrow, so tests supply an in-memory Stripe. */
export interface OrgBillingStripe {
  createCustomer(params: OrgCustomerCreateParams, idempotencyKey: string): Promise<{ id: string }>;
  updateCustomer(customerId: string, details: OrgCustomerDetails, idempotencyKey: string): Promise<void>;
  findCustomerByOrgId(orgId: string): Promise<string | null>;
  createSubscription(params: OrgBusinessSubscriptionParams, idempotencyKey: string): Promise<OrgStripeSubscription>;
  retrieveSubscription(subscriptionId: string): Promise<OrgStripeSubscription>;
  listCustomerSubscriptions(customerId: string): Promise<OrgStripeSubscription[]>;
  createSubscriptionItem(
    params: { subscriptionId: string; priceId: string; quantity: number },
    idempotencyKey: string,
  ): Promise<{ id: string; quantity: number }>;
  updateSubscriptionItemQuantity(
    params: { itemId: string; quantity: number; prorationBehavior: SeatProrationBehavior },
    idempotencyKey: string,
  ): Promise<{ id: string; quantity: number }>;
  /** Cancel now; a subscription that is already over is left as it is. */
  cancelSubscription(subscriptionId: string, idempotencyKey: string): Promise<{ status: string }>;
  /** The subscription's latest invoice with its confirmation secret, or null when it has none. */
  latestInvoice(subscriptionId: string): Promise<OrgLatestInvoice | null>;
  /** A Stripe billing-portal session on `customerId` (the org's). */
  createBillingPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }>;
  /** One page of `customerId`'s invoices, newest first. */
  listInvoices(customerId: string, opts: { limit: number; startingAfter?: string }): Promise<{ invoices: OrgInvoiceSummary[]; hasMore: boolean }>;
}

export interface OrgBillingDeps {
  stripe: OrgBillingStripe;
  prices: () => OrgBusinessPrices;
  /** SEAT-3's count: accepted members plus live pending invites. */
  countSeats: (orgId: string) => Promise<number>;
}

export type OrgBillingErrorCode =
  | 'org_not_found'
  | 'prices_not_configured'
  | 'not_an_org_business_subscription'
  /** Stripe answered a create with a subscription that is already over; never stored as live. */
  | 'subscription_not_live'
  /** The org has no Stripe customer yet: nothing to open a portal on. */
  | 'no_billing_customer';

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
  const key = orgBillingLockKey(orgId);
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
      // Keyed on the org alone: a retry replays the first create whatever changed since.
      const customer = await deps.stripe.createCustomer(orgCustomerCreateParams({ orgId }), orgCustomerCreateKey(orgId));
      customerId = customer.id;
    }
    // Name and billing email as they are NOW, set after the create (absolute values, so a
    // replay is harmless and a rename between attempts simply wins).
    const [owner] = await tx.select({ email: users.email }).from(users).where(eq(users.id, org.ownerId)).limit(1);
    const details = orgCustomerDetails({ name: org.name, billingEmail: owner?.email ?? null });
    await deps.stripe.updateCustomer(customerId, details, orgStripeIdempotencyKey(orgId, 'customer.update', { customerId, details }));
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

/** Mirror what Stripe says now about the stored subscription onto its row. */
async function refreshStored(tx: Tx, orgId: string, sub: OrgStripeSubscription): Promise<OrgSubscription> {
  const [row] = await tx
    .update(orgSubscriptions)
    .set({
      status: sub.status,
      trialEnd: fromUnix(sub.trialEnd),
      currentPeriodStart: fromUnix(sub.currentPeriodStart),
      currentPeriodEnd: fromUnix(sub.currentPeriodEnd),
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    })
    .where(eq(orgSubscriptions.orgId, orgId))
    .returning();
  return row;
}

/**
 * SEAT-1, SEAT-8, A-8: the org's Business subscription — the base price plus the
 * extra-seat item at max(0, seats − 5), with no trial ([D-OW-30]): a new subscription
 * starts `incomplete`, waiting for its first payment. Idempotent: an org that
 * already has a live subscription gets it back with no Stripe write (one status read);
 * one Stripe has but the database lost is adopted; one that ended is followed by a new
 * subscription whose create key names the ended one.
 */
export async function ensureOrgBusinessSubscription(
  orgId: string,
  deps: OrgBillingDeps = defaultOrgBillingDeps(),
): Promise<EnsureOrgSubscriptionResult> {
  const prices = configuredPrices(deps);
  const { customerId } = await ensureOrgStripeCustomer(orgId, deps);

  const result = await db.transaction(async (tx) => {
    await lockOrgBilling(tx, orgId);
    // The org may have been deleted while this call waited for the lock: never create a
    // Stripe subscription for an org that is gone (the delete holds the same lock).
    const [org] = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) throw new OrgBillingError('org_not_found', `Organization ${orgId} not found`);

    let [stored] = await tx.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId)).limit(1);
    if (stored && isLiveOrgSubscriptionStatus(stored.status)) {
      stored = await refreshStored(tx, orgId, await deps.stripe.retrieveSubscription(stored.stripeSubscriptionId));
      if (isLiveOrgSubscriptionStatus(stored.status)) return { kind: 'existing' as const, linkage: toLinkage(stored, customerId) };
    }

    const history = await deps.stripe.listCustomerSubscriptions(customerId);
    const existing = pickAdoptableOrgSubscription(history, { orgId, prices });
    let sub: OrgStripeSubscription;
    let kind: 'created' | 'adopted';
    if (existing) {
      sub = existing;
      kind = 'adopted';
    } else {
      const seats = await deps.countSeats(orgId);
      const seen = orgSubscriptionHistory(history, { orgId });
      const params = orgBusinessSubscriptionParams({ orgId, customerId, seats, prices });
      // The generation this subscription follows: Stripe's newest for the org (it also
      // sees a lost create that has since ended), else the stored one, else none.
      const previous = seen.previousSubscriptionId ?? stored?.stripeSubscriptionId ?? null;
      sub = await deps.stripe.createSubscription(params, orgSubscriptionCreateKey(orgId, params, previous));
      if (!isLiveOrgSubscriptionStatus(sub.status)) {
        throw new OrgBillingError('subscription_not_live', `Stripe returned subscription ${sub.id} already ${sub.status}`);
      }
      kind = 'created';
    }

    const items = orgSubscriptionItems(sub, prices);
    if (!items) {
      throw new OrgBillingError('not_an_org_business_subscription', `Subscription ${sub.id} has no Business base item`);
    }
    // An adopted subscription made outside this path may lack the seat item: add it at
    // the org's current extra-seat quantity, never 0 (that would under-bill until the next
    // membership change).
    let seatItem = items.seatItem;
    if (!seatItem) {
      const quantity = orgExtraSeatQuantity(await deps.countSeats(orgId));
      seatItem = await deps.stripe.createSubscriptionItem(
        { subscriptionId: sub.id, priceId: prices.seatPriceId, quantity },
        orgStripeIdempotencyKey(orgId, 'seat-item.create', { subscriptionId: sub.id, priceId: prices.seatPriceId, quantity }),
      );
    }

    const row = await storeSubscription(tx, orgId, sub, prices, seatItem, items.baseItemId);
    loggers.api.info('org business subscription linked', { orgId, subscriptionId: sub.id, kind, status: sub.status });
    return { kind, linkage: toLinkage(row, customerId) };
  });
  if (result.kind !== 'existing') {
    // AUD-1: the org's subscription began (at creation, or a re-subscribe after one ended).
    await recordOrgAuditEventAfterCommit({
      orgId,
      eventType: 'org.billing.subscription_changed',
      resourceType: 'org_subscription',
      resourceId: orgId,
      details: { source: 'provisioning', kind: result.kind, to: result.linkage.status },
    });
  }
  return result;
}

/**
 * A-8: bring the extra-seat quantity to max(0, seats − 5) for the org's CURRENT seat
 * count (SEAT-3's count, `deps.countSeats`), read under the billing lock — so two
 * concurrent changes apply in lock order and the last one always reflects the latest
 * count, never a stale lower one. Seat accounting (D2) decides when to call; raising
 * defaults to a prorated change (SEAT-4), and a caller freeing seats at period end
 * passes `prorationBehavior: 'none'` (SEAT-5). A replay of the same change is a no-op.
 */
export async function syncOrgSeatQuantity(
  orgId: string,
  opts: { prorationBehavior?: SeatProrationBehavior } = {},
  deps: OrgBillingDeps = defaultOrgBillingDeps(),
): Promise<SeatSyncResult> {
  const prorationBehavior = opts.prorationBehavior ?? 'create_prorations';
  return db.transaction(async (tx) => {
    await lockOrgBilling(tx, orgId);
    const [stored] = await tx.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId)).limit(1);
    if (!stored || !isLiveOrgSubscriptionStatus(stored.status)) return { kind: 'no_subscription' as const };

    const seats = await deps.countSeats(orgId);
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

/**
 * The org delete's `endSubscription` port (ORG-6 meets SEAT-1): cancel the org's live
 * Stripe subscription immediately, keyed so a retried delete replays the cancel. Runs
 * inside the delete's transaction; a throw rolls the delete back.
 */
export function endOrgSubscriptionPort(
  deps: OrgBillingDeps = defaultOrgBillingDeps(),
): (subscription: { orgId: string; stripeSubscriptionId: string }) => Promise<void> {
  return async ({ orgId, stripeSubscriptionId }) => {
    const { status } = await deps.stripe.cancelSubscription(
      stripeSubscriptionId,
      orgStripeIdempotencyKey(orgId, 'subscription.cancel', { subscriptionId: stripeSubscriptionId }),
    );
    loggers.api.info('org subscription canceled with the org', { orgId, subscriptionId: stripeSubscriptionId, status });
  };
}

/**
 * What paying for the org's subscription needs right now (review 3+4 P1-1): the latest
 * invoice's confirmation secret when the subscription owes its first or a failed payment,
 * else nothing. Read from Stripe only when the status can owe anything.
 */
export async function orgPaymentStepFor(
  linkage: Pick<OrgSubscriptionLinkage, 'stripeSubscriptionId' | 'status'>,
  deps: OrgBillingDeps = defaultOrgBillingDeps(),
): Promise<OrgPaymentStep> {
  if (!orgSubscriptionMayOwePayment(linkage.status)) return { kind: 'none' };
  const latestInvoice = await deps.stripe.latestInvoice(linkage.stripeSubscriptionId);
  return orgPaymentStep({ subscriptionStatus: linkage.status, latestInvoice });
}

/**
 * SEAT-8, SEAT-9 recovery: make sure the org has its Business subscription and say what
 * the client must do to pay for it. The one entry point org creation and the
 * (re-)subscribe route use: a new org, a lapsed org re-subscribing, and an org whose card
 * failed all get the open invoice's client secret; an org that owes nothing gets none.
 */
export async function provisionOrgSubscription(
  orgId: string,
  deps: OrgBillingDeps = defaultOrgBillingDeps(),
): Promise<{ result: EnsureOrgSubscriptionResult; payment: OrgPaymentStep }> {
  const result = await ensureOrgBusinessSubscription(orgId, deps);
  return { result, payment: await orgPaymentStepFor(result.linkage, deps) };
}

/** The org's own Stripe customer as stored, or null. Never a member's customer. */
async function storedOrgCustomerId(orgId: string): Promise<string | null> {
  const [org] = await db
    .select({ stripeCustomerId: organizations.stripeCustomerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new OrgBillingError('org_not_found', `Organization ${orgId} not found`);
  return org.stripeCustomerId;
}

/**
 * SEAT-6: a Stripe billing-portal session on the ORG's customer (payment method, billing
 * email, invoices) — never the Owner's personal customer. An org that has no customer yet
 * is refused before any Stripe call: it subscribes first.
 */
export async function createOrgBillingPortalSession(
  orgId: string,
  returnUrl: string,
  deps: OrgBillingDeps = defaultOrgBillingDeps(),
): Promise<{ url: string }> {
  const customerId = await storedOrgCustomerId(orgId);
  if (!customerId) throw new OrgBillingError('no_billing_customer', `Organization ${orgId} has no billing customer yet`);
  return deps.stripe.createBillingPortalSession(customerId, returnUrl);
}

/** SEAT-6: one page of the ORG's invoices, newest first; none before the org has a customer. */
export async function listOrgInvoices(
  orgId: string,
  opts: { limit: number; startingAfter?: string },
  deps: OrgBillingDeps = defaultOrgBillingDeps(),
): Promise<{ invoices: OrgInvoiceSummary[]; hasMore: boolean }> {
  const customerId = await storedOrgCustomerId(orgId);
  if (!customerId) return { invoices: [], hasMore: false };
  return deps.stripe.listInvoices(customerId, opts);
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

const isoFromUnix = (s: number | null | undefined): string | null => (typeof s === 'number' ? new Date(s * 1000).toISOString() : null);

function toOrgInvoiceSummary(invoice: Stripe.Invoice): OrgInvoiceSummary {
  return {
    id: invoice.id ?? '',
    number: invoice.number ?? null,
    status: invoice.status ?? null,
    amountDue: invoice.amount_due,
    amountPaid: invoice.amount_paid,
    currency: invoice.currency,
    created: new Date(invoice.created * 1000).toISOString(),
    periodStart: isoFromUnix(invoice.period_start),
    periodEnd: isoFromUnix(invoice.period_end),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdf: invoice.invoice_pdf ?? null,
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
    async cancelSubscription(subscriptionId, idempotencyKey) {
      const current = await client.subscriptions.retrieve(subscriptionId);
      if (!isLiveOrgSubscriptionStatus(current.status)) return { status: current.status };
      const canceled = await client.subscriptions.cancel(subscriptionId, {}, { idempotencyKey });
      return { status: canceled.status };
    },
    async updateCustomer(customerId, details, idempotencyKey) {
      await client.customers.update(customerId, details, { idempotencyKey });
    },
    async retrieveSubscription(subscriptionId) {
      return toOrgStripeSubscription(await client.subscriptions.retrieve(subscriptionId));
    },
    async updateSubscriptionItemQuantity(params, idempotencyKey) {
      const item = await client.subscriptionItems.update(
        params.itemId,
        { quantity: params.quantity, proration_behavior: params.prorationBehavior },
        { idempotencyKey },
      );
      return { id: item.id, quantity: item.quantity ?? 0 };
    },
    async latestInvoice(subscriptionId) {
      const sub = await client.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice.confirmation_secret'] });
      const invoice = sub.latest_invoice;
      if (!invoice || typeof invoice === 'string') return null;
      return {
        status: invoice.status ?? null,
        amountDueCents: invoice.amount_due,
        clientSecret: invoice.confirmation_secret?.client_secret ?? null,
      };
    },
    async createBillingPortalSession(customerId, returnUrl) {
      const session = await client.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
      return { url: session.url };
    },
    async listInvoices(customerId, opts) {
      const page = await client.invoices.list({ customer: customerId, limit: opts.limit, starting_after: opts.startingAfter });
      return { invoices: page.data.map(toOrgInvoiceSummary), hasMore: page.has_more };
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

// ---------------------------------------------------------------------------
// What routes return
// ---------------------------------------------------------------------------

/** What a route may show about the org's subscription: never a Stripe id. */
export interface OrgSubscriptionSummary {
  status: string;
  trialEnd: string | null;
  currentPeriodEnd: string | null;
  extraSeatQuantity: number;
}

export function orgSubscriptionSummary(linkage: OrgSubscriptionLinkage): OrgSubscriptionSummary {
  return {
    status: linkage.status,
    trialEnd: linkage.trialEnd?.toISOString() ?? null,
    currentPeriodEnd: linkage.currentPeriodEnd?.toISOString() ?? null,
    extraSeatQuantity: linkage.extraSeatQuantity,
  };
}

/**
 * The org's billing state right after it is created (SEAT-8 as amended by [D-OW-30]:
 * creating an org takes a card at checkout, there is no trial):
 *   - `not_billed` where billing is off (onprem, tenant) — no Stripe call is made;
 *   - `payment_required` with the subscription awaiting its first payment and the client
 *     secret the client confirms a card with (the usual answer);
 *   - `subscribed` when nothing is owed (a subscription already paid for);
 *   - `pending` when Stripe could not be reached: the org exists without a
 *     subscription, nothing half-written, and POST /api/orgs/[orgId]/billing/subscription
 *     provisions it on retry. Either way the org spends nothing until it has paid.
 */
export type OrgBillingStart =
  | { state: 'not_billed' }
  | { state: 'payment_required'; subscription: OrgSubscriptionSummary; payment: Extract<OrgPaymentStep, { kind: 'confirm_payment' }> }
  | { state: 'subscribed'; subscription: OrgSubscriptionSummary }
  | { state: 'pending' };

export async function startOrgBusinessSubscription(
  orgId: string,
  deps: OrgBillingDeps = defaultOrgBillingDeps(),
): Promise<OrgBillingStart> {
  if (!isBillingEnabled()) return { state: 'not_billed' };
  try {
    const { result, payment } = await provisionOrgSubscription(orgId, deps);
    const subscription = orgSubscriptionSummary(result.linkage);
    return payment.kind === 'confirm_payment' ? { state: 'payment_required', subscription, payment } : { state: 'subscribed', subscription };
  } catch (error) {
    loggers.api.error('org business subscription could not start; the org is left unsubscribed and retryable', error as Error, { orgId });
    return { state: 'pending' };
  }
}
