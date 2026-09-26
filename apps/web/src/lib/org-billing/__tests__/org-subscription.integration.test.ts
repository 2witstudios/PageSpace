// @vitest-environment node
/**
 * The org Business subscription shell against a REAL Postgres, with an in-memory
 * Stripe (FakeOrgStripe) that honours idempotency keys, lags search, and can lose a
 * response after executing a write. Proves what the database and the lock guarantee:
 * one customer and one subscription per org under concurrent and replayed calls, the
 * linkage stored on the org, the extra-seat quantity, and a failure that leaves the
 * org retryable. The same shell against the real Stripe test API is
 * org-subscription.stripe.integration.test.ts.
 *
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one (requireDb).
 * Deletes every row it creates, children first, users last.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { createOrganization } from '@pagespace/lib/organizations/repository';
import { ORG_ID_METADATA_KEY, type OrgBusinessPrices } from '@pagespace/lib/billing/org-subscription-core';
import {
  ensureOrgBusinessSubscription,
  ensureOrgStripeCustomer,
  startOrgBusinessTrial,
  syncOrgSeatQuantity,
  type OrgBillingDeps,
} from '../org-subscription';
import { FakeOrgStripe } from './fake-org-stripe';

const PRICES: OrgBusinessPrices = { basePriceId: 'price_base_test', seatPriceId: 'price_seat_test' };

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;
const orgIds: string[] = [];
const userIds: string[] = [];

async function northwind(seats = 1): Promise<{ orgId: string; ownerId: string; deps: OrgBillingDeps; stripe: FakeOrgStripe }> {
  const owner = await factories.createUser({ email: `jono+${Date.now()}${Math.random().toString(36).slice(2, 8)}@northwind.test`, name: 'Jono' });
  userIds.push(owner.id);
  const slug = `northwind-${Math.random().toString(36).slice(2, 10)}`;
  const created = await createOrganization({ name: 'Northwind Labs', slug, ownerId: owner.id });
  if (!created.ok) throw new Error(`org create failed: ${created.reason}`);
  orgIds.push(created.organization.id);
  const stripe = new FakeOrgStripe();
  const deps: OrgBillingDeps = {
    stripe,
    prices: () => PRICES,
    countSeats: async () => seats,
  };
  return { orgId: created.organization.id, ownerId: owner.id, deps, stripe };
}

async function rowsFor(orgId: string) {
  return db.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId));
}

async function orgRow(orgId: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  return org;
}

describe('org Business subscription shell (real Postgres, in-memory Stripe)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: orgSubscriptions.id }).from(orgSubscriptions).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('org-subscription.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    if (orgIds.length > 0) {
      await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  });

  it('SEAT-1 SEAT-8 (partial) A-8 creating the subscription makes one org customer and one trialing Business subscription with the seat item at quantity 0, and stores the linkage on the org', async () => {
    if (!dbAvailable) return;
    const { orgId, ownerId, deps, stripe } = await northwind(1);

    const result = await ensureOrgBusinessSubscription(orgId, deps);

    expect(result.kind).toBe('created');
    expect(stripe.customers.size).toBe(1);
    const [customer] = [...stripe.customers.values()];
    // The org's own customer: named for the org, tagged with the org id — not the Owner's personal customer.
    expect(customer.params.metadata).toEqual({ [ORG_ID_METADATA_KEY]: orgId, kind: 'organization' });
    expect(customer.params.name).toBe('Northwind Labs');
    const [owner] = await db.select({ stripeCustomerId: users.stripeCustomerId }).from(users).where(eq(users.id, ownerId));
    expect(owner.stripeCustomerId).toBeNull();

    const org = await orgRow(orgId);
    expect(org.stripeCustomerId).toBe(customer.id);
    const [sub] = [...stripe.subscriptions.values()];
    expect(org.stripeSubscriptionId).toBe(sub.id);
    expect(sub.status).toBe('trialing');
    expect(sub.items.map((i) => [i.priceId, i.quantity])).toEqual([
      [PRICES.basePriceId, 1],
      [PRICES.seatPriceId, 0],
    ]);

    const rows = await rowsFor(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stripeSubscriptionId: sub.id,
      stripeBasePriceId: PRICES.basePriceId,
      stripeBaseItemId: sub.items[0].id,
      stripeSeatPriceId: PRICES.seatPriceId,
      stripeSeatItemId: sub.items[1].id,
      extraSeatQuantity: 0,
      status: 'trialing',
    });
    expect(rows[0].trialEnd).toBeInstanceOf(Date);
  });

  it('A-8 an org created with 7 seats starts at extra-seat quantity 2', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe } = await northwind(7);
    await ensureOrgBusinessSubscription(orgId, deps);
    const [sub] = [...stripe.subscriptions.values()];
    expect(stripe.seatQuantity(sub.id, PRICES.seatPriceId)).toBe(2);
    expect((await rowsFor(orgId))[0].extraSeatQuantity).toBe(2);
  });

  it('SEAT-1 a replayed call on a provisioned org touches Stripe not at all and changes nothing', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe } = await northwind(1);
    const first = await ensureOrgBusinessSubscription(orgId, deps);
    const writesAfterFirst = { ...stripe.writes };
    const readsAfterFirst = { ...stripe.reads };
    stripe.expireIdempotencyKeys(); // even long after Stripe forgot the keys

    const replay = await ensureOrgBusinessSubscription(orgId, deps);

    expect(replay.kind).toBe('existing');
    expect(replay.linkage.stripeSubscriptionId).toBe(first.linkage.stripeSubscriptionId);
    expect(stripe.writes).toEqual(writesAfterFirst);
    expect(stripe.reads).toEqual(readsAfterFirst);
    expect(stripe.customers.size).toBe(1);
    expect(stripe.subscriptions.size).toBe(1);
    expect(await rowsFor(orgId)).toHaveLength(1);
  });

  it('SEAT-1 two concurrent first calls for one org create one customer and one subscription, and both see the same linkage', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe } = await northwind(1);
    stripe.writeDelayMs = 30;
    stripe.searchLag = true;

    const [a, b] = await Promise.all([ensureOrgBusinessSubscription(orgId, deps), ensureOrgBusinessSubscription(orgId, deps)]);

    expect(stripe.writes.createCustomer).toBe(1);
    expect(stripe.writes.createSubscription).toBe(1);
    expect(a.linkage.stripeSubscriptionId).toBe(b.linkage.stripeSubscriptionId);
    expect([a.kind, b.kind].sort()).toEqual(['created', 'existing']);
    expect(await rowsFor(orgId)).toHaveLength(1);
  });

  it('SEAT-1 concurrent customer lookups for one org never make two customers', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe } = await northwind(1);
    stripe.writeDelayMs = 30;
    stripe.searchLag = true;
    const ids = await Promise.all([1, 2, 3].map(() => ensureOrgStripeCustomer(orgId, deps)));
    expect(new Set(ids.map((r) => r.customerId)).size).toBe(1);
    expect(stripe.writes.createCustomer).toBe(1);
  });

  it('SEAT-1 a customer create whose response was lost is replayed with the same key: the retry gets the same customer, never a second', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe } = await northwind(1);
    stripe.searchLag = true; // the new customer is not searchable yet
    stripe.loseNextResponse('createCustomer');

    await expect(ensureOrgBusinessSubscription(orgId, deps)).rejects.toThrow(/connection to Stripe/);
    // The failure left no half-written linkage that would block a retry.
    expect((await orgRow(orgId)).stripeCustomerId).toBeNull();
    expect(await rowsFor(orgId)).toHaveLength(0);

    const retry = await ensureOrgBusinessSubscription(orgId, deps);
    expect(retry.kind).toBe('created');
    expect(stripe.writes.createCustomer).toBe(1);
    expect(stripe.customers.size).toBe(1);
    expect(new Set(stripe.keysSeen.filter((k) => k.includes(':customer.create:'))).size).toBe(1);
  });

  it('SEAT-1 a customer Stripe created but the database never recorded is found again after the key window, not duplicated', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe } = await northwind(1);
    stripe.loseNextResponse('createCustomer');
    await expect(ensureOrgStripeCustomer(orgId, deps)).rejects.toThrow();
    stripe.expireIdempotencyKeys();
    stripe.indexSearch();

    const again = await ensureOrgStripeCustomer(orgId, deps);
    expect(again.created).toBe(false);
    expect(stripe.customers.size).toBe(1);
    expect((await orgRow(orgId)).stripeCustomerId).toBe(again.customerId);
  });

  it('SEAT-1 a subscription Stripe created but the database never recorded is adopted on retry, not duplicated — even after the key window', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe } = await northwind(1);
    stripe.loseNextResponse('createSubscription');
    await expect(ensureOrgBusinessSubscription(orgId, deps)).rejects.toThrow(/connection to Stripe/);
    // The customer committed on its own; the subscription row did not.
    expect((await orgRow(orgId)).stripeCustomerId).not.toBeNull();
    expect(await rowsFor(orgId)).toHaveLength(0);
    stripe.expireIdempotencyKeys();

    const retry = await ensureOrgBusinessSubscription(orgId, deps);
    expect(retry.kind).toBe('adopted');
    expect(stripe.writes.createSubscription).toBe(1);
    expect(stripe.subscriptions.size).toBe(1);
    expect((await rowsFor(orgId))[0].stripeSubscriptionId).toBe([...stripe.subscriptions.keys()][0]);
  });

  it('SEAT-1 a Stripe outage on subscription create leaves the org retryable: no subscription row, and the next call provisions', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe } = await northwind(1);
    stripe.failNext('createSubscription', Object.assign(new Error('Stripe is unavailable'), { type: 'StripeAPIError' }));
    await expect(ensureOrgBusinessSubscription(orgId, deps)).rejects.toThrow(/unavailable/);
    expect(await rowsFor(orgId)).toHaveLength(0);

    const retry = await ensureOrgBusinessSubscription(orgId, deps);
    expect(retry.kind).toBe('created');
    expect(stripe.subscriptions.size).toBe(1);
  });

  it('SEAT-8 (partial) an org whose subscription was canceled gets a new one without a second trial', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe } = await northwind(1);
    const first = await ensureOrgBusinessSubscription(orgId, deps);
    await db.update(orgSubscriptions).set({ status: 'canceled' }).where(eq(orgSubscriptions.orgId, orgId));
    const sub = stripe.subscriptions.get(first.linkage.stripeSubscriptionId);
    if (sub) sub.status = 'canceled';

    const again = await ensureOrgBusinessSubscription(orgId, deps);
    expect(again.kind).toBe('created');
    expect(again.linkage.stripeSubscriptionId).not.toBe(first.linkage.stripeSubscriptionId);
    const fresh = stripe.subscriptions.get(again.linkage.stripeSubscriptionId);
    expect(fresh?.status).toBe('incomplete');
    expect(fresh?.trialEnd).toBeNull();
    const rows = await rowsFor(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].stripeSubscriptionId).toBe(again.linkage.stripeSubscriptionId);
    expect((await orgRow(orgId)).stripeSubscriptionId).toBe(again.linkage.stripeSubscriptionId);
  });

  it('A-8 adding a 6th seat raises the extra-seat quantity to 1; 7 seats to 2; back to 5 seats to 0; a replay is a no-op', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe } = await northwind(1);
    const { linkage } = await ensureOrgBusinessSubscription(orgId, deps);

    expect(await syncOrgSeatQuantity(orgId, 6, {}, deps)).toEqual({ kind: 'updated', quantity: 1 });
    expect(stripe.seatQuantity(linkage.stripeSubscriptionId, PRICES.seatPriceId)).toBe(1);
    expect(await syncOrgSeatQuantity(orgId, 7, {}, deps)).toEqual({ kind: 'updated', quantity: 2 });
    expect(await syncOrgSeatQuantity(orgId, 7, {}, deps)).toEqual({ kind: 'noop', quantity: 2 });
    expect(await syncOrgSeatQuantity(orgId, 5, { prorationBehavior: 'none' }, deps)).toEqual({ kind: 'updated', quantity: 0 });
    expect(stripe.seatQuantity(linkage.stripeSubscriptionId, PRICES.seatPriceId)).toBe(0);
    expect(stripe.writes.updateSubscriptionItemQuantity).toBe(3);
    const [row] = await rowsFor(orgId);
    expect(row).toMatchObject({ extraSeatQuantity: 0, seatRevision: 3 });
  });

  it('A-8 a seat change whose response was lost is replayed with the same key and applied once', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe } = await northwind(1);
    const { linkage } = await ensureOrgBusinessSubscription(orgId, deps);
    stripe.loseNextResponse('updateSubscriptionItemQuantity');
    await expect(syncOrgSeatQuantity(orgId, 8, {}, deps)).rejects.toThrow();
    expect((await rowsFor(orgId))[0].extraSeatQuantity).toBe(0);

    expect(await syncOrgSeatQuantity(orgId, 8, {}, deps)).toEqual({ kind: 'updated', quantity: 3 });
    expect(stripe.writes.updateSubscriptionItemQuantity).toBe(1);
    expect(stripe.seatQuantity(linkage.stripeSubscriptionId, PRICES.seatPriceId)).toBe(3);
  });

  it('A-8 syncing seats for an org with no subscription does nothing and says so', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe } = await northwind(1);
    expect(await syncOrgSeatQuantity(orgId, 9, {}, deps)).toEqual({ kind: 'no_subscription' });
    expect(stripe.writes.updateSubscriptionItemQuantity).toBe(0);
  });

  it('refuses an unknown org and refuses to run with an unconfigured price, before any Stripe write', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe } = await northwind(1);
    await expect(ensureOrgBusinessSubscription('org_does_not_exist', deps)).rejects.toMatchObject({ code: 'org_not_found' });
    const unconfigured: OrgBillingDeps = { ...deps, prices: () => ({ basePriceId: '', seatPriceId: PRICES.seatPriceId }) };
    await expect(ensureOrgBusinessSubscription(orgId, unconfigured)).rejects.toMatchObject({ code: 'prices_not_configured' });
    expect(stripe.writes).toEqual({ createCustomer: 0, createSubscription: 0, createSubscriptionItem: 0, updateSubscriptionItemQuantity: 0 });
  });

  it('SEAT-8 (partial) starting the trial on org creation: a cloud org is subscribed and trialing, with no Stripe id in what the route sees', async () => {
    if (!dbAvailable) return;
    process.env.DEPLOYMENT_MODE = 'cloud';
    const { orgId, deps } = await northwind(1);
    const start = await startOrgBusinessTrial(orgId, deps);
    expect(start).toMatchObject({ state: 'subscribed', subscription: { status: 'trialing', extraSeatQuantity: 0 } });
    expect(JSON.stringify(start)).not.toMatch(/cus_|sub_|si_/);
  });

  it('SEAT-8 (partial) where billing is off (onprem, tenant) no org is billed and Stripe is never called', async () => {
    if (!dbAvailable) return;
    for (const mode of ['onprem', 'tenant']) {
      process.env.DEPLOYMENT_MODE = mode;
      const { orgId, deps, stripe } = await northwind(1);
      expect(await startOrgBusinessTrial(orgId, deps)).toEqual({ state: 'not_billed' });
      expect(stripe.writes.createCustomer + stripe.reads.findCustomerByOrgId).toBe(0);
      expect(await rowsFor(orgId)).toHaveLength(0);
    }
  });

  it('SEAT-8 (partial) a Stripe outage while the org is created leaves it pending and unsubscribed, and a later call provisions it', async () => {
    if (!dbAvailable) return;
    process.env.DEPLOYMENT_MODE = 'cloud';
    const { orgId, deps, stripe } = await northwind(1);
    stripe.failNext('createCustomer', Object.assign(new Error('Stripe is unavailable'), { type: 'StripeAPIError' }));
    expect(await startOrgBusinessTrial(orgId, deps)).toEqual({ state: 'pending' });
    expect((await orgRow(orgId)).stripeCustomerId).toBeNull();
    expect(await rowsFor(orgId)).toHaveLength(0);
    expect((await ensureOrgBusinessSubscription(orgId, deps)).linkage.status).toBe('trialing');
  });
});
