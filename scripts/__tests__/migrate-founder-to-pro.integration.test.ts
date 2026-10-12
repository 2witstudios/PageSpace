import { afterAll, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { createMigrationStore, runFounderMigration } from '../migrate-founder-to-pro';

const ids: string[] = [];
const proPriceId = `price_pro_${createId()}`;
const retiredPriceId = `price_retired_${createId()}`;
async function seed() {
  const user = await factories.createUser({ subscriptionTier: 'founder', stripeCustomerId: `cus_${createId()}` });
  ids.push(user.id);
  await db.insert(subscriptions).values({ userId: user.id, stripeSubscriptionId: `sub_${createId()}`, stripePriceId: proPriceId,
    status: 'active', currentPeriodStart: new Date('2026-10-01'), currentPeriodEnd: new Date('2026-11-01') });
  const [wallet] = await db.insert(wallets).values({ ownerType: 'user', userId: user.id, monthlyRemainingCents: 123, topupRemainingCents: 456 }).returning();
  return { user, wallet };
}
afterAll(async () => {
  if (!ids.length) return;
  await db.delete(wallets).where(inArray(wallets.userId, ids));
  await db.delete(users).where(inArray(users.id, ids));
});

describe('D-OW-42 Founder migration PostgreSQL writes', () => {
  it('A-9 preserves every wallet field and applies an idempotent verified normalization', async () => {
    const { user, wallet } = await seed();
    const store = createMigrationStore(db);
    const candidates = (await store.listCandidates()).filter((row) => row.id === user.id);
    const deps = { ...store, proPriceId,
      listCandidates: async () => (await store.listCandidates()).filter((row) => row.id === user.id),
      readCustomerSubscriptions: async () => [{ id: candidates[0].subscriptions[0].id, customerId: user.stripeCustomerId!, status: 'active', priceIds: [proPriceId], scheduled: false }],
    };
    expect(candidates).toHaveLength(1);
    expect((await runFounderMigration(deps, { apply: false })).normalized).toBe(1);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].subscriptionTier).toBe('founder');
    expect((await runFounderMigration(deps, { apply: true })).normalized).toBe(1);
    expect((await runFounderMigration(deps, { apply: true })).normalized).toBe(0);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].subscriptionTier).toBe('pro');
    expect((await db.select().from(wallets).where(eq(wallets.id, wallet.id)))[0]).toEqual(wallet);
  });
  it('A-9 a delivered webhook cannot remove a migrated subscriber from preflight', async () => {
    const { user } = await seed();
    await db.update(users).set({ subscriptionTier: 'free' }).where(eq(users.id, user.id));
    await db.update(subscriptions).set({ stripePriceId: 'price_unknown_replacement' }).where(eq(subscriptions.userId, user.id));
    const store = createMigrationStore(db);
    const candidates = (await store.listCandidates()).filter((row) => row.id === user.id);
    expect(candidates).toHaveLength(1);
    const result = await runFounderMigration({ ...store, proPriceId,
      listCandidates: async () => candidates,
      readCustomerSubscriptions: async () => [{ id: candidates[0].subscriptions[0].id, customerId: user.stripeCustomerId!, status: 'active', priceIds: ['price_unknown_replacement'], scheduled: false }],
    }, { apply: true });
    expect(result.ready).toBe(false);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].subscriptionTier).toBe('free');
  });

  it('A-9 a changed mirror aborts the entire apply transaction', async () => {
    const first = await seed();
    const second = await seed();
    const store = createMigrationStore(db);
    const observed = (await store.listCandidates()).filter((row) => [first.user.id, second.user.id].includes(row.id));
    await db.update(subscriptions).set({ stripePriceId: retiredPriceId }).where(eq(subscriptions.userId, second.user.id));
    await expect(store.apply(observed.map((user) => ({ user, tier: 'pro' as const })))).rejects.toThrow('evidence changed');
    const rows = await db.select().from(users).where(inArray(users.id, [first.user.id, second.user.id]));
    expect(rows.map((user) => user.subscriptionTier)).toEqual(['founder', 'founder']);
    expect((await db.select().from(wallets).where(eq(wallets.id, first.wallet.id)))[0]).toEqual(first.wallet);
  });
});
