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
import { deleteOrganization } from '@pagespace/lib/organizations/deletion';
import { ORG_ID_METADATA_KEY, type OrgBusinessPrices } from '@pagespace/lib/billing/org-subscription-core';
import {
  ensureOrgBusinessSubscription,
  ensureOrgStripeCustomer,
  endOrgSubscriptionPort,
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

interface Northwind {
  orgId: string;
  ownerId: string;
  deps: OrgBillingDeps;
  stripe: FakeOrgStripe;
  /** SEAT-3's count as the org would report it now. */
  seats: { count: number };
}

async function northwind(initialSeats = 1): Promise<Northwind> {
  const owner = await factories.createUser({ email: `jono+${Date.now()}${Math.random().toString(36).slice(2, 8)}@northwind.test`, name: 'Jono' });
  userIds.push(owner.id);
  const slug = `northwind-${Math.random().toString(36).slice(2, 10)}`;
  const created = await createOrganization({ name: 'Northwind Labs', slug, ownerId: owner.id });
  if (!created.ok) throw new Error(`org create failed: ${created.reason}`);
  orgIds.push(created.organization.id);
  const stripe = new FakeOrgStripe();
  const seats = { count: initialSeats };
  const deps: OrgBillingDeps = {
    stripe,
    prices: () => PRICES,
    countSeats: async () => seats.count,
  };
  return { orgId: created.organization.id, ownerId: owner.id, deps, stripe, seats };
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
    expect(customer.details?.name).toBe('Northwind Labs');
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

  it('SEAT-1 a replayed call on a provisioned org makes no Stripe write — one status read only — and changes nothing', async () => {
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
    expect(stripe.reads).toEqual({ ...readsAfterFirst, retrieveSubscription: readsAfterFirst.retrieveSubscription + 1 });
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
    const { orgId, deps, stripe, seats } = await northwind(1);
    const { linkage } = await ensureOrgBusinessSubscription(orgId, deps);

    seats.count = 6;
    expect(await syncOrgSeatQuantity(orgId, {}, deps)).toEqual({ kind: 'updated', quantity: 1 });
    expect(stripe.seatQuantity(linkage.stripeSubscriptionId, PRICES.seatPriceId)).toBe(1);
    seats.count = 7;
    expect(await syncOrgSeatQuantity(orgId, {}, deps)).toEqual({ kind: 'updated', quantity: 2 });
    expect(await syncOrgSeatQuantity(orgId, {}, deps)).toEqual({ kind: 'noop', quantity: 2 });
    seats.count = 5;
    expect(await syncOrgSeatQuantity(orgId, { prorationBehavior: 'none' }, deps)).toEqual({ kind: 'updated', quantity: 0 });
    expect(stripe.seatQuantity(linkage.stripeSubscriptionId, PRICES.seatPriceId)).toBe(0);
    expect(stripe.writes.updateSubscriptionItemQuantity).toBe(3);
    const [row] = await rowsFor(orgId);
    expect(row).toMatchObject({ extraSeatQuantity: 0, seatRevision: 3 });
  });

  it('A-8 a seat change whose response was lost is replayed with the same key and applied once', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe, seats } = await northwind(1);
    const { linkage } = await ensureOrgBusinessSubscription(orgId, deps);
    stripe.loseNextResponse('updateSubscriptionItemQuantity');
    seats.count = 8;
    await expect(syncOrgSeatQuantity(orgId, {}, deps)).rejects.toThrow();
    expect((await rowsFor(orgId))[0].extraSeatQuantity).toBe(0);

    expect(await syncOrgSeatQuantity(orgId, {}, deps)).toEqual({ kind: 'updated', quantity: 3 });
    expect(stripe.writes.updateSubscriptionItemQuantity).toBe(1);
    expect(stripe.seatQuantity(linkage.stripeSubscriptionId, PRICES.seatPriceId)).toBe(3);
  });

  it('A-8 syncing seats for an org with no subscription does nothing and says so', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe, seats } = await northwind(1);
    seats.count = 9;
    expect(await syncOrgSeatQuantity(orgId, {}, deps)).toEqual({ kind: 'no_subscription' });
    expect(stripe.writes.updateSubscriptionItemQuantity).toBe(0);
  });

  it('refuses an unknown org and refuses to run with an unconfigured price, before any Stripe write', async () => {
    if (!dbAvailable) return;
    const { orgId, deps, stripe } = await northwind(1);
    await expect(ensureOrgBusinessSubscription('org_does_not_exist', deps)).rejects.toMatchObject({ code: 'org_not_found' });
    const unconfigured: OrgBillingDeps = { ...deps, prices: () => ({ basePriceId: '', seatPriceId: PRICES.seatPriceId }) };
    await expect(ensureOrgBusinessSubscription(orgId, unconfigured)).rejects.toMatchObject({ code: 'prices_not_configured' });
    expect(Object.values(stripe.writes).every((n) => n === 0)).toBe(true);
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

  describe('deleting an org that has a subscription (ORG-6 meets SEAT-1)', () => {
    const noKick = { broadcast: async () => {}, kick: async () => {} };

    it('SEAT-1 (partial) cancels the live Stripe subscription and removes its row with the org, so nothing keeps billing a deleted org', async () => {
      if (!dbAvailable) return;
      const { orgId, ownerId, deps, stripe } = await northwind(1);
      const { linkage } = await ensureOrgBusinessSubscription(orgId, deps);

      const result = await deleteOrganization(
        { actorId: ownerId, orgId, choices: [], now: new Date() },
        { ports: noKick, endSubscription: endOrgSubscriptionPort(deps) },
      );

      expect(result.ok).toBe(true);
      expect(stripe.subscriptions.get(linkage.stripeSubscriptionId)?.status).toBe('canceled');
      expect(await rowsFor(orgId)).toHaveLength(0);
      expect(await orgRow(orgId)).toBeUndefined();
    });

    it('SEAT-1 (partial) a Stripe failure while canceling refuses the whole delete: the org, its row and its subscription all stay, and a retry completes', async () => {
      if (!dbAvailable) return;
      const { orgId, ownerId, deps, stripe } = await northwind(1);
      const { linkage } = await ensureOrgBusinessSubscription(orgId, deps);
      stripe.failNext('cancelSubscription', Object.assign(new Error('Stripe is unavailable'), { type: 'StripeAPIError' }));

      await expect(
        deleteOrganization({ actorId: ownerId, orgId, choices: [], now: new Date() }, { ports: noKick, endSubscription: endOrgSubscriptionPort(deps) }),
      ).rejects.toThrow(/unavailable/);
      expect(await orgRow(orgId)).toBeDefined();
      expect(await rowsFor(orgId)).toHaveLength(1);
      expect(stripe.subscriptions.get(linkage.stripeSubscriptionId)?.status).toBe('trialing');

      const retry = await deleteOrganization(
        { actorId: ownerId, orgId, choices: [], now: new Date() },
        { ports: noKick, endSubscription: endOrgSubscriptionPort(deps) },
      );
      expect(retry.ok).toBe(true);
      expect(stripe.subscriptions.get(linkage.stripeSubscriptionId)?.status).toBe('canceled');
    });

    it('SEAT-1 (partial) a caller with no way to end the subscription cannot delete a subscribed org (fails closed, nothing changes)', async () => {
      if (!dbAvailable) return;
      const { orgId, ownerId, deps } = await northwind(1);
      await ensureOrgBusinessSubscription(orgId, deps);
      await expect(deleteOrganization({ actorId: ownerId, orgId, choices: [], now: new Date() }, { ports: noKick })).rejects.toThrow(
        /subscription/,
      );
      expect(await orgRow(orgId)).toBeDefined();
      expect(await rowsFor(orgId)).toHaveLength(1);
    });

    it('an org whose subscription already ended is deleted without a Stripe call', async () => {
      if (!dbAvailable) return;
      const { orgId, ownerId, deps, stripe } = await northwind(1);
      await ensureOrgBusinessSubscription(orgId, deps);
      await db.update(orgSubscriptions).set({ status: 'canceled' }).where(eq(orgSubscriptions.orgId, orgId));
      const result = await deleteOrganization({ actorId: ownerId, orgId, choices: [], now: new Date() }, { ports: noKick });
      expect(result.ok).toBe(true);
      expect(stripe.writes.cancelSubscription).toBe(0);
      expect(await rowsFor(orgId)).toHaveLength(0);
    });
  });

  describe('review 5328226999 on #2733', () => {
    it('SEAT-1 (P1-A) a customer create whose response was lost, then an org rename and an owner email change while search cannot see it: exactly ONE customer, carrying the new details', async () => {
      if (!dbAvailable) return;
      const { orgId, ownerId, deps, stripe } = await northwind(1);
      stripe.searchLag = true;
      stripe.loseNextResponse('createCustomer');
      await expect(ensureOrgStripeCustomer(orgId, deps)).rejects.toThrow(/connection to Stripe/);

      await db.update(organizations).set({ name: 'Northwind Labs Inc' }).where(eq(organizations.id, orgId));
      await db.update(users).set({ email: `billing+${ownerId}@northwind.test` }).where(eq(users.id, ownerId));

      const again = await ensureOrgStripeCustomer(orgId, deps);
      expect(stripe.customers.size).toBe(1);
      expect(stripe.writes.createCustomer).toBe(1);
      const [customer] = [...stripe.customers.values()];
      expect(again.customerId).toBe(customer.id);
      expect(customer.details).toEqual({ name: 'Northwind Labs Inc', email: `billing+${ownerId}@northwind.test` });
    });

    it('SEAT-1 (P1-B) re-subscribing within 24h after an ended subscription creates a NEW live subscription instead of replaying the dead one', async () => {
      if (!dbAvailable) return;
      const { orgId, deps, stripe } = await northwind(1);
      // Each end is mirrored on the row as a webhook would (D3), so this isolates the KEY.
      const end = async (id: string, status: 'canceled' | 'incomplete_expired') => {
        stripe.endSubscription(id, status);
        await db.update(orgSubscriptions).set({ status }).where(eq(orgSubscriptions.orgId, orgId));
      };
      const a = await ensureOrgBusinessSubscription(orgId, deps);
      await end(a.linkage.stripeSubscriptionId, 'canceled');
      const b = await ensureOrgBusinessSubscription(orgId, deps);
      expect(b.linkage.stripeSubscriptionId).not.toBe(a.linkage.stripeSubscriptionId);
      // B (no trial, same seats, same customer) ends inside Stripe's key window.
      await end(b.linkage.stripeSubscriptionId, 'incomplete_expired');

      const c = await ensureOrgBusinessSubscription(orgId, deps);
      expect(c.kind).toBe('created');
      expect(c.linkage.stripeSubscriptionId).not.toBe(b.linkage.stripeSubscriptionId);
      expect(stripe.liveSubscriptions(a.linkage.stripeCustomerId).map((x) => x.id)).toEqual([c.linkage.stripeSubscriptionId]);
      const [row] = await rowsFor(orgId);
      expect(row.stripeSubscriptionId).toBe(c.linkage.stripeSubscriptionId);
    });

    it('SEAT-1 (P1-B) a create that Stripe answers with an ended subscription is never stored as live', async () => {
      if (!dbAvailable) return;
      const { orgId, deps, stripe } = await northwind(1);
      const real = stripe.createSubscription.bind(stripe);
      stripe.createSubscription = async (params, key) => ({ ...(await real(params, key)), status: 'incomplete_expired' });
      await expect(ensureOrgBusinessSubscription(orgId, deps)).rejects.toMatchObject({ code: 'subscription_not_live' });
      expect(await rowsFor(orgId)).toHaveLength(0);
    });

    it('SEAT-1 (Codex P1 / P2-3) a stored trial that Stripe already canceled is refreshed from Stripe, and the org can subscribe again (no second trial)', async () => {
      if (!dbAvailable) return;
      const { orgId, deps, stripe } = await northwind(1);
      const first = await ensureOrgBusinessSubscription(orgId, deps);
      stripe.endSubscription(first.linkage.stripeSubscriptionId); // cardless trial ended; no webhook yet (D3)

      const again = await ensureOrgBusinessSubscription(orgId, deps);
      expect(again.kind).toBe('created');
      expect(again.linkage.stripeSubscriptionId).not.toBe(first.linkage.stripeSubscriptionId);
      expect(stripe.subscriptions.get(again.linkage.stripeSubscriptionId)?.trialEnd).toBeNull();
    });

    it('SEAT-1 a stored subscription still live in Stripe has its mirrored status refreshed (trialing → active)', async () => {
      if (!dbAvailable) return;
      const { orgId, deps, stripe } = await northwind(1);
      const first = await ensureOrgBusinessSubscription(orgId, deps);
      const sub = stripe.subscriptions.get(first.linkage.stripeSubscriptionId);
      if (sub) sub.status = 'active';
      const again = await ensureOrgBusinessSubscription(orgId, deps);
      expect(again).toMatchObject({ kind: 'existing', linkage: { status: 'active' } });
      expect((await rowsFor(orgId))[0].status).toBe('active');
    });

    it('SEAT-8 (Codex P2) a lost create whose subscription ended before the retry does not earn a second trial', async () => {
      if (!dbAvailable) return;
      const { orgId, deps, stripe } = await northwind(1);
      stripe.loseNextResponse('createSubscription');
      await expect(ensureOrgBusinessSubscription(orgId, deps)).rejects.toThrow();
      const [lost] = [...stripe.subscriptions.values()];
      stripe.endSubscription(lost.id);
      stripe.expireIdempotencyKeys();

      const retry = await ensureOrgBusinessSubscription(orgId, deps);
      expect(retry.linkage.stripeSubscriptionId).not.toBe(lost.id);
      expect(stripe.subscriptions.get(retry.linkage.stripeSubscriptionId)?.trialEnd).toBeNull();
    });

    it('A-8 (Codex P2) repairing an adopted subscription that lacks the seat item creates it at the org\'s current quantity, not 0', async () => {
      if (!dbAvailable) return;
      const { orgId, deps, stripe, seats } = await northwind(8);
      stripe.loseNextResponse('createSubscription');
      await expect(ensureOrgBusinessSubscription(orgId, deps)).rejects.toThrow();
      const [sub] = [...stripe.subscriptions.values()];
      sub.items = sub.items.filter((i) => i.priceId === PRICES.basePriceId); // made without the seat item
      seats.count = 8;

      const adopted = await ensureOrgBusinessSubscription(orgId, deps);
      expect(adopted.kind).toBe('adopted');
      expect(stripe.seatQuantity(sub.id, PRICES.seatPriceId)).toBe(3);
      expect((await rowsFor(orgId))[0].extraSeatQuantity).toBe(3);
    });

    it('A-8 (P2-2) the seat count is taken under the billing lock: two concurrent changes end at the LATER count', async () => {
      if (!dbAvailable) return;
      const { orgId, deps, stripe, seats } = await northwind(1);
      const { linkage } = await ensureOrgBusinessSubscription(orgId, deps);
      stripe.writeDelayMs = 30;
      seats.count = 9;
      const first = syncOrgSeatQuantity(orgId, {}, deps);
      await new Promise((r) => setTimeout(r, 5));
      seats.count = 7; // a member left while the first change was in flight
      const second = syncOrgSeatQuantity(orgId, {}, deps);
      await Promise.all([first, second]);
      expect(stripe.seatQuantity(linkage.stripeSubscriptionId, PRICES.seatPriceId)).toBe(2);
      expect((await rowsFor(orgId))[0].extraSeatQuantity).toBe(2);
    });

    it('SEAT-1 (P2-1) an org delete racing an in-flight provisioning never leaves a live Stripe subscription for a deleted org', async () => {
      if (!dbAvailable) return;
      const { orgId, ownerId, deps, stripe } = await northwind(1);
      await ensureOrgStripeCustomer(orgId, deps);
      const customerId = (await orgRow(orgId)).stripeCustomerId as string;
      stripe.writeDelayMs = 60;
      const provisioning = ensureOrgBusinessSubscription(orgId, deps).catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 15));
      const deleted = await deleteOrganization(
        { actorId: ownerId, orgId, choices: [], now: new Date() },
        { ports: { broadcast: async () => {}, kick: async () => {} }, endSubscription: endOrgSubscriptionPort(deps) },
      );
      await provisioning;
      expect(deleted.ok).toBe(true);
      expect(await orgRow(orgId)).toBeUndefined();
      expect(stripe.liveSubscriptions(customerId)).toHaveLength(0);
    });

    it('SEAT-1 (Codex P2) Stripe canceled but the delete transaction failed: the org stays, and the retried delete completes without a second cancel', async () => {
      if (!dbAvailable) return;
      const { orgId, ownerId, deps, stripe } = await northwind(1);
      const { linkage } = await ensureOrgBusinessSubscription(orgId, deps);
      const port = endOrgSubscriptionPort(deps);
      const noKick = { broadcast: async () => {}, kick: async () => {} };
      await expect(
        deleteOrganization(
          { actorId: ownerId, orgId, choices: [], now: new Date() },
          { ports: noKick, endSubscription: async (sub) => { await port(sub); throw new Error('connection lost after the cancel'); } },
        ),
      ).rejects.toThrow(/connection lost/);
      expect(await orgRow(orgId)).toBeDefined();
      expect(stripe.subscriptions.get(linkage.stripeSubscriptionId)?.status).toBe('canceled');

      const retry = await deleteOrganization({ actorId: ownerId, orgId, choices: [], now: new Date() }, { ports: noKick, endSubscription: port });
      expect(retry.ok).toBe(true);
      expect(stripe.writes.cancelSubscription).toBe(1);
      expect(await rowsFor(orgId)).toHaveLength(0);
    });
  });
});
