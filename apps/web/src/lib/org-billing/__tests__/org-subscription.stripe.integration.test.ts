// @vitest-environment node
/**
 * The org Business subscription shell against the REAL Stripe TEST API and a real
 * Postgres (Spec SEAT-1, SEAT-8, A-8). Runs only when STRIPE_TEST_SECRET_KEY is set,
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
  orgStripeIdempotencyKey,
  type OrgBusinessPrices,
} from '@pagespace/lib/billing/org-subscription-core';
import { stripeConfig, stripeMode } from '@/lib/stripe-config';
import {
  endOrgSubscriptionPort,
  ensureOrgBusinessSubscription,
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

async function testOrg(seats: number): Promise<{ orgId: string; ownerId: string; email: string; deps: OrgBillingDeps }> {
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
  return { orgId: created.organization.id, ownerId: owner.id, email, deps: { stripe: stripeOrgBilling(client), prices: () => PRICES, countSeats: async () => seats } };
}

async function seatQuantityInStripe(subscriptionId: string): Promise<number | undefined> {
  const sub = await client.subscriptions.retrieve(subscriptionId);
  return sub.items.data.find((i) => i.price.id === PRICES.seatPriceId)?.quantity;
}

describe.skipIf(!TEST_KEY)('org Business subscription against the Stripe TEST API', () => {
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

  it('SEAT-1 SEAT-8 (partial) A-8 a new org gets its own customer and a trialing Business subscription: base ×1, seat item ×0, cancel if no card at trial end; add a 6th seat → 1, a 7th → 2', async () => {
    const { orgId, deps } = await testOrg(1);
    const result = await ensureOrgBusinessSubscription(orgId, deps);
    customerIds.add(result.linkage.stripeCustomerId);

    const customer = await client.customers.retrieve(result.linkage.stripeCustomerId);
    if (customer.deleted) throw new Error('customer deleted');
    expect(customer.livemode).toBe(false);
    expect(customer.metadata).toEqual({ [ORG_ID_METADATA_KEY]: orgId, kind: 'organization' });
    expect(customer.name).toBe(`Northwind Labs [${RUN}]`);

    const sub = await client.subscriptions.retrieve(result.linkage.stripeSubscriptionId);
    expect(sub.livemode).toBe(false);
    expect(sub.status).toBe('trialing');
    expect(sub.customer).toBe(result.linkage.stripeCustomerId);
    expect(sub.metadata).toEqual({ [ORG_ID_METADATA_KEY]: orgId, kind: ORG_SUBSCRIPTION_KIND });
    expect(sub.trial_settings?.end_behavior?.missing_payment_method).toBe('cancel');
    expect(sub.items.data.map((i) => [i.price.id, i.quantity])).toEqual([
      [PRICES.basePriceId, 1],
      [PRICES.seatPriceId, 0],
    ]);

    const [row] = await db.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId));
    expect(row).toMatchObject({ stripeSubscriptionId: sub.id, status: 'trialing', extraSeatQuantity: 0 });
    expect(row.stripeBaseItemId).toBe(sub.items.data[0].id);
    expect(row.stripeSeatItemId).toBe(sub.items.data[1].id);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org.stripeCustomerId).toBe(customer.id);
    expect(org.stripeSubscriptionId).toBe(sub.id);

    expect(await syncOrgSeatQuantity(orgId, 6, {}, deps)).toEqual({ kind: 'updated', quantity: 1 });
    expect(await seatQuantityInStripe(sub.id)).toBe(1);
    expect(await syncOrgSeatQuantity(orgId, 7, {}, deps)).toEqual({ kind: 'updated', quantity: 2 });
    expect(await seatQuantityInStripe(sub.id)).toBe(2);
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
    const params = orgBusinessSubscriptionParams({ orgId, customerId: first.linkage.stripeCustomerId, seats: 1, prices: PRICES, trialDays: 14 });
    const replayed = await client.subscriptions.create(params, { idempotencyKey: orgStripeIdempotencyKey(orgId, 'subscription.create', params) });
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
    expect((await client.subscriptions.retrieve(linkage.stripeSubscriptionId)).status).toBe('canceled');
    // The port on an already-ended subscription leaves it alone rather than erroring.
    await expect(endOrgSubscriptionPort(deps)({ orgId, stripeSubscriptionId: linkage.stripeSubscriptionId })).resolves.toBeUndefined();
  });
});
