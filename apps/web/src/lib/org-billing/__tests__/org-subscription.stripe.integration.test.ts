// @vitest-environment node
/**
 * The org Business subscription shell against the REAL Stripe TEST API and a real
 * Postgres (Spec SEAT-1, SEAT-6, SEAT-8, SEAT-9, A-8; [D-OW-30] no org trial). Runs only when STRIPE_TEST_SECRET_KEY is set,
 * and refuses to run at all unless that key is a TEST key (sk_test_…) and both org
 * prices report livemode false. It never reads STRIPE_SECRET_KEY, and it never goes
 * through the app's Stripe client: the client here is built from the test key alone.
 *
 * Every Stripe object it creates is named "[ow-d1 test <run>]" and deleted in
 * afterAll (deleting a customer cancels its subscriptions); every database row it
 * creates is deleted children first, users last.
 *
 * Local run (the test key comes from the developer's .env, never CI):
 *   STRIPE_TEST_SECRET_KEY=sk_test_… DATABASE_URL=… bunx vitest run <this file>
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Stripe from 'stripe';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { createOrganization } from '@pagespace/lib/organizations/repository';
import { deleteOrganization } from '@pagespace/lib/organizations/deletion';
import { centsFromDollars, tierListPriceCents } from '@pagespace/lib/billing/money-model';
import { TIER_PLAN_LIMITS } from '@pagespace/lib/billing/subscription-tiers';
import {
  ORG_ID_METADATA_KEY,
  ORG_SUBSCRIPTION_KIND,
  orgBusinessSubscriptionParams,
  orgSubscriptionCreateKey,
  type OrgBusinessPrices,
} from '@pagespace/lib/billing/org-subscription-core';
import { stripeConfig, stripeMode } from '@/lib/stripe-config';
import {
  createOrgBillingPortalSession,
  endOrgSubscriptionPort,
  ensureOrgBusinessSubscription,
  listOrgInvoices,
  provisionOrgSubscription,
  stripeOrgBilling,
  syncOrgSeatQuantity,
  type OrgBillingDeps,
} from '../org-subscription';

const TEST_KEY = process.env.STRIPE_TEST_SECRET_KEY;
const RUN = `ow-d1 test ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PRICES: OrgBusinessPrices = { basePriceId: stripeConfig.orgPriceIds.businessBase, seatPriceId: stripeConfig.orgPriceIds.extraSeat };

let client: Stripe;
const orgIds: string[] = [];
const userIds: string[] = [];
const customerIds = new Set<string>();

async function testOrg(
  initialSeats: number,
): Promise<{ orgId: string; ownerId: string; email: string; deps: OrgBillingDeps; seats: { count: number } }> {
  const seats = { count: initialSeats };
  const email = `jono+${RUN.replace(/\W/g, '')}${orgIds.length}@northwind.test`;
  const owner = await factories.createUser({ email, name: 'Jono' });
  userIds.push(owner.id);
  const created = await createOrganization({
    name: `Northwind Labs [${RUN}]`,
    slug: `northwind-${Math.random().toString(36).slice(2, 10)}`,
    ownerId: owner.id,
  });
  if (!created.ok) throw new Error(`org create failed: ${created.reason}`);
  orgIds.push(created.organization.id);
  return { orgId: created.organization.id, ownerId: owner.id, email, deps: { stripe: stripeOrgBilling(client), prices: () => PRICES, countSeats: async () => seats.count }, seats };
}

async function seatQuantityInStripe(subscriptionId: string): Promise<number | undefined> {
  const sub = await client.subscriptions.retrieve(subscriptionId);
  return sub.items.data.find((i) => i.price.id === PRICES.seatPriceId)?.quantity;
}

/**
 * What the client's Payment Element does with the secret the route hands out: confirm the
 * invoice's PaymentIntent with a card. A TEST card (pm_card_visa) stands in for the person
 * typing one; nothing else is called — no invoice is paid out of band.
 */
async function confirmWithClientSecret(clientSecret: string): Promise<Stripe.PaymentIntent> {
  const paymentIntentId = clientSecret.split('_secret_')[0];
  return client.paymentIntents.confirm(paymentIntentId, { payment_method: 'pm_card_visa', return_url: 'https://app.pagespace.test/return' });
}

// Real network: one test makes up to ~9 Stripe calls, so the 5 s default is too tight.
describe.skipIf(!TEST_KEY)('org Business subscription against the Stripe TEST API', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    if (!TEST_KEY?.startsWith('sk_test_')) throw new Error('STRIPE_TEST_SECRET_KEY must be a Stripe TEST key (sk_test_…); refusing to run');
    expect(stripeMode).toBe('test');
    try {
      await db.select({ id: orgSubscriptions.id }).from(orgSubscriptions).limit(1);
    } catch (error) {
      requireDb('org-subscription.stripe.integration.test.ts', error);
      throw error;
    }
    client = new Stripe(TEST_KEY, { apiVersion: '2026-02-25.clover' });
  });

  afterAll(async () => {
    for (const id of customerIds) {
      await client.customers.del(id).catch(() => undefined);
    }
    if (orgIds.length > 0) {
      await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  });

  it('SEAT-2 (partial) A-8 the configured org prices are TEST-mode prices whose amounts agree with the tier table (Stripe never sources an amount)', async () => {
    const [base, seat] = await Promise.all([client.prices.retrieve(PRICES.basePriceId), client.prices.retrieve(PRICES.seatPriceId)]);
    expect(base.livemode).toBe(false);
    expect(seat.livemode).toBe(false);
    expect(base.unit_amount).toBe(tierListPriceCents('business'));
    expect(seat.unit_amount).toBe(centsFromDollars(TIER_PLAN_LIMITS.business.extraSeatUsd));
    expect(base.metadata.included_seats).toBe(String(TIER_PLAN_LIMITS.business.includedSeats));
  });

  it('SEAT-1 SEAT-8 (partial) A-8 D-OW-30 a new org gets its own customer and a Business subscription with NO trial, waiting on its first invoice (base ×1, seat item ×0), and the client secret to pay it', async () => {
    const { orgId, deps } = await testOrg(1);
    const { result, payment } = await provisionOrgSubscription(orgId, deps);
    customerIds.add(result.linkage.stripeCustomerId);

    const customer = await client.customers.retrieve(result.linkage.stripeCustomerId);
    if (customer.deleted) throw new Error('customer deleted');
    expect(customer.livemode).toBe(false);
    expect(customer.metadata).toEqual({ [ORG_ID_METADATA_KEY]: orgId, kind: 'organization' });
    expect(customer.name).toBe(`Northwind Labs [${RUN}]`);

    const sub = await client.subscriptions.retrieve(result.linkage.stripeSubscriptionId, { expand: ['latest_invoice'] });
    expect(sub.livemode).toBe(false);
    expect(sub.status).toBe('incomplete');
    expect(sub.trial_end).toBeNull();
    expect(sub.customer).toBe(result.linkage.stripeCustomerId);
    expect(sub.metadata).toEqual({ [ORG_ID_METADATA_KEY]: orgId, kind: ORG_SUBSCRIPTION_KIND });
    expect(sub.items.data.map((i) => [i.price.id, i.quantity])).toEqual([
      [PRICES.basePriceId, 1],
      [PRICES.seatPriceId, 0],
    ]);
    const invoice = sub.latest_invoice as Stripe.Invoice;
    expect(invoice.status).toBe('open');
    expect(invoice.amount_due).toBe(tierListPriceCents('business'));
    expect(payment.kind).toBe('confirm_payment');

    const [row] = await db.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId));
    expect(row).toMatchObject({ stripeSubscriptionId: sub.id, status: 'incomplete', extraSeatQuantity: 0, trialEnd: null });
    expect(row.stripeBaseItemId).toBe(sub.items.data[0].id);
    expect(row.stripeSeatItemId).toBe(sub.items.data[1].id);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org.stripeCustomerId).toBe(customer.id);
    expect(org.stripeSubscriptionId).toBe(sub.id);
  });

  it('SEAT-8 (partial) SEAT-9 (partial) review 3+4 P1-1 the client secret pays the first invoice: confirming a card with it makes the subscription active with no out-of-band step; then a 6th seat → 1, a 7th → 2', async () => {
    const { orgId, deps, seats } = await testOrg(1);
    const first = await provisionOrgSubscription(orgId, deps);
    customerIds.add(first.result.linkage.stripeCustomerId);
    if (first.payment.kind !== 'confirm_payment') throw new Error('no payment step');

    const intent = await confirmWithClientSecret(first.payment.clientSecret);
    expect(intent.status).toBe('succeeded');
    expect(intent.amount).toBe(tierListPriceCents('business'));

    const after = await provisionOrgSubscription(orgId, deps);
    expect(after.result).toMatchObject({ kind: 'existing', linkage: { status: 'active' } });
    expect(after.payment).toEqual({ kind: 'none' });
    const subId = first.result.linkage.stripeSubscriptionId;
    expect((await client.subscriptions.retrieve(subId)).default_payment_method).toBeTruthy();

    seats.count = 6;
    expect(await syncOrgSeatQuantity(orgId, {}, deps)).toEqual({ kind: 'updated', quantity: 1 });
    expect(await seatQuantityInStripe(subId)).toBe(1);
    seats.count = 7;
    expect(await syncOrgSeatQuantity(orgId, {}, deps)).toEqual({ kind: 'updated', quantity: 2 });
    expect(await seatQuantityInStripe(subId)).toBe(2);
  });

  it('SEAT-6 (partial) the billing portal and the invoice list open on the ORG\'s customer: the paid first invoice is listed, and a portal session opens (its customer is the stored org customer, proven against the fake)', async () => {
    const { orgId, deps } = await testOrg(1);
    const first = await provisionOrgSubscription(orgId, deps);
    customerIds.add(first.result.linkage.stripeCustomerId);
    if (first.payment.kind !== 'confirm_payment') throw new Error('no payment step');
    await confirmWithClientSecret(first.payment.clientSecret);

    const page = await listOrgInvoices(orgId, { limit: 10 }, deps);
    expect(page.hasMore).toBe(false);
    expect(page.invoices).toHaveLength(1);
    expect(page.invoices[0]).toMatchObject({ status: 'paid', amountPaid: tierListPriceCents('business'), currency: 'usd' });

    const portal = await createOrgBillingPortalSession(orgId, 'https://app.pagespace.test/orgs/x/settings', deps);
    expect(portal.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
  });

  it('A-8 an org provisioned with 7 seats starts at extra-seat quantity 2 in Stripe', async () => {
    const { orgId, deps } = await testOrg(7);
    const result = await ensureOrgBusinessSubscription(orgId, deps);
    customerIds.add(result.linkage.stripeCustomerId);
    expect(await seatQuantityInStripe(result.linkage.stripeSubscriptionId)).toBe(2);
  });

  it('SEAT-1 a concurrent double call and a replay leave exactly one customer and one subscription in Stripe', async () => {
    const { orgId, email, deps } = await testOrg(1);
    const [a, b] = await Promise.all([ensureOrgBusinessSubscription(orgId, deps), ensureOrgBusinessSubscription(orgId, deps)]);
    customerIds.add(a.linkage.stripeCustomerId);
    customerIds.add(b.linkage.stripeCustomerId);
    const replay = await ensureOrgBusinessSubscription(orgId, deps);

    expect(new Set([a, b, replay].map((r) => r.linkage.stripeCustomerId)).size).toBe(1);
    expect(new Set([a, b, replay].map((r) => r.linkage.stripeSubscriptionId)).size).toBe(1);
    const customers = await client.customers.list({ email, limit: 10 });
    expect(customers.data).toHaveLength(1);
    const subs = await client.subscriptions.list({ customer: a.linkage.stripeCustomerId, status: 'all', limit: 10 });
    expect(subs.data).toHaveLength(1);
  });

  it('SEAT-1 Stripe honours the derived key: replaying the exact create request returns the same subscription, not a second', async () => {
    const { orgId, deps } = await testOrg(1);
    const first = await ensureOrgBusinessSubscription(orgId, deps);
    customerIds.add(first.linkage.stripeCustomerId);
    const params = orgBusinessSubscriptionParams({ orgId, customerId: first.linkage.stripeCustomerId, seats: 1, prices: PRICES });
    const replayed = await client.subscriptions.create(params, { idempotencyKey: orgSubscriptionCreateKey(orgId, params, null) });
    expect(replayed.id).toBe(first.linkage.stripeSubscriptionId);
    const subs = await client.subscriptions.list({ customer: first.linkage.stripeCustomerId, status: 'all', limit: 10 });
    expect(subs.data).toHaveLength(1);
  });

  it('SEAT-1 (partial) deleting the org cancels its subscription in Stripe inside the delete, and a second cancel of the ended subscription is not attempted', async () => {
    const { orgId, ownerId, deps } = await testOrg(1);
    const { linkage } = await ensureOrgBusinessSubscription(orgId, deps);
    customerIds.add(linkage.stripeCustomerId);
    const noKick = { broadcast: async () => {}, kick: async () => {} };

    const deleted = await deleteOrganization({ actorId: ownerId, orgId, choices: [], now: new Date() }, { ports: noKick, endSubscription: endOrgSubscriptionPort(deps) });
    expect(deleted.ok).toBe(true);
    // An unpaid (incomplete) subscription that is canceled ends as incomplete_expired in Stripe; a paid one as canceled.
    expect(['canceled', 'incomplete_expired']).toContain((await client.subscriptions.retrieve(linkage.stripeSubscriptionId)).status);
    // The port on an already-ended subscription leaves it alone rather than erroring.
    await expect(endOrgSubscriptionPort(deps)({ orgId, stripeSubscriptionId: linkage.stripeSubscriptionId })).resolves.toBeUndefined();
  });
});
