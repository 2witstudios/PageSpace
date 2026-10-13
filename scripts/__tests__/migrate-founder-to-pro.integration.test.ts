import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createId } from '@paralleldrive/cuid2';
import { schema } from '@pagespace/db/schema';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { wallets } from '@pagespace/db/schema/wallets';
import { creditLedger } from '@pagespace/db/schema/credits';
import { spendableCentsFor } from '@pagespace/lib/billing/credit-balance';
import { createMigrationStore, runFounderMigration } from '../migrate-founder-to-pro';

const schemaName = `cutover_${createId()}`;
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, options: `-c search_path=${schemaName},public` });
const db = drizzle(pool, { schema });
beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
  // A private pre-cutover fixture schema keeps legacy seeds out of the final
  // application's constrained users table and cannot affect concurrent suites.
  for (const table of ['users', 'subscriptions', 'wallets', 'credit_ledger']) {
    await pool.query(`CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING DEFAULTS)`);
  }
});
beforeEach(async () => {
  await pool.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_personal_subscription_tier');
  await pool.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_retired_billing_cleared');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS "subscriptionGrandfathered" boolean NOT NULL DEFAULT false');
  await pool.query('TRUNCATE users, subscriptions, wallets, credit_ledger');
});
const proPriceId = `price_pro_${createId()}`;
const retiredPriceId = `price_retired_${createId()}`;
async function seed(tier = 'founder') {
  const [user] = await db.insert(users).values({ name: 'Migration fixture', email: `${createId()}@example.test`, subscriptionTier: tier, stripeCustomerId: `cus_${createId()}` }).returning();
  await db.insert(subscriptions).values({ userId: user.id, stripeSubscriptionId: `sub_${createId()}`, stripePriceId: proPriceId,
    status: 'active', currentPeriodStart: new Date('2026-10-01'), currentPeriodEnd: new Date('2026-11-01') });
  const [wallet] = await db.insert(wallets).values({ ownerType: 'user', userId: user.id, monthlyRemainingCents: 123, topupRemainingCents: 456,
    monthlyPeriodStart: new Date('2026-09-01'), monthlyPeriodEnd: new Date('2026-10-01') }).returning();
  return { user, wallet };
}
afterAll(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await adminPool.end();
});

describe('D-OW-42 Founder migration PostgreSQL writes', () => {
  it('A-9 an explicit ended Business to Free migration preserves spendable credit value', async () => {
    const { user, wallet } = await seed('business');
    await db.update(subscriptions).set({ status: 'canceled', stripePriceId: retiredPriceId }).where(eq(subscriptions.userId, user.id));
    const store = createMigrationStore(db);
    const [candidate] = await store.listCandidates();
    expect((await runFounderMigration({ ...store, proPriceId, businessDestinations: new Map([[user.id, 'free']]),
      readCustomerSubscriptions: async () => [{ id: candidate.subscriptions[0].id, customerId: user.stripeCustomerId!, status: 'canceled', priceIds: [retiredPriceId], scheduled: false }],
    }, { apply: true })).ready).toBe(true);
    const [after] = await db.select().from(wallets);
    expect(after).toEqual(wallet);
    expect(spendableCentsFor(after, 'free')).toBe(spendableCentsFor(wallet, 'business'));
  });
  it('A-9 rejects a grandfathering flag change after verification and blocks dropping an uncleared flag', async () => {
    const { user } = await seed('pro');
    const store = createMigrationStore(db);
    const [observed] = await store.listCandidates();
    await pool.query('UPDATE users SET "subscriptionGrandfathered" = true WHERE id = $1', [user.id]);
    await expect(store.apply([{ user: observed, tier: 'pro' }], [observed])).rejects.toThrow('evidence changed');
    const guardSql = await readFile(new URL('../../packages/db/drizzle/0360_personal_billing_cutover_guard.sql', import.meta.url), 'utf8');
    await expect(pool.query(guardSql)).rejects.toThrow('users_retired_billing_cleared');
    expect((await store.listCandidates())[0].grandfathered).toBe(true);
  });
  it('A-9 blocks schema cutover until Business is verified, preserves wallet/ledger values, and reruns after flag removal', async () => {
    const { user, wallet } = await seed('business');
    await pool.query('UPDATE users SET "subscriptionGrandfathered" = true WHERE id = $1', [user.id]);
    const [ledger] = await db.insert(creditLedger).values({ userId: user.id, walletId: wallet.id, entryType: 'topup_purchase', bucket: 'topup', amountCents: 456, consumeStatus: 'applied' }).returning();
    const guardSql = await readFile(new URL('../../packages/db/drizzle/0360_personal_billing_cutover_guard.sql', import.meta.url), 'utf8');
    const dropSql = await readFile(new URL('../../packages/db/drizzle/0361_drop_personal_grandfathering.sql', import.meta.url), 'utf8');
    await expect(pool.query(guardSql)).rejects.toThrow('users_personal_subscription_tier');
    const store = createMigrationStore(db);
    const [candidate] = await store.listCandidates();
    const deps = { ...store, proPriceId, businessDestinations: new Map([[user.id, 'pro' as const]]),
      readCustomerSubscriptions: async () => [{ id: candidate.subscriptions[0].id, customerId: user.stripeCustomerId!, status: 'active', priceIds: [proPriceId], scheduled: false }],
    };
    expect((await runFounderMigration(deps, { apply: false })).normalized).toBe(1);
    expect((await store.listCandidates())[0]).toMatchObject({ tier: 'business', grandfathered: true });
    expect((await runFounderMigration(deps, { apply: true })).normalized).toBe(1);
    expect((await db.select().from(wallets))[0]).toEqual(wallet);
    expect((await db.select().from(creditLedger))[0]).toEqual(ledger);
    await pool.query(guardSql);
    await pool.query(dropSql);
    expect((await runFounderMigration(deps, { apply: true })).normalized).toBe(0);
    await expect(db.update(users).set({ subscriptionTier: 'business' }).where(eq(users.id, user.id))).rejects.toThrow();
  });
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

  it.each([true, false])('A-9 a stale unchanged Pro candidate aborts apply, with pending writes=%s', async (hasWrites) => {
    const stable = await seed();
    const pending = hasWrites ? await seed() : null;
    await db.update(users).set({ subscriptionTier: 'pro' }).where(eq(users.id, stable.user.id));
    const store = createMigrationStore(db);
    const scope = [stable.user.id, ...(pending ? [pending.user.id] : [])];
    const observed = (await store.listCandidates()).filter((row) => scope.includes(row.id));
    const deps = { ...store, proPriceId, listCandidates: async () => observed,
      readCustomerSubscriptions: async (customerId: string) => {
        const user = observed.find((row) => row.customerId === customerId)!;
        return [{ id: user.subscriptions[0].id, customerId, status: 'active', priceIds: [proPriceId], scheduled: false }];
      },
      apply: async (...args: Parameters<typeof store.apply>) => {
        await db.update(subscriptions).set({ stripePriceId: retiredPriceId }).where(eq(subscriptions.userId, stable.user.id));
        await store.apply(...args);
      },
    };
    await expect(runFounderMigration(deps, { apply: true })).rejects.toThrow('evidence changed');
    if (pending) expect((await db.select().from(users).where(eq(users.id, pending.user.id)))[0].subscriptionTier).toBe('founder');
    expect((await db.select().from(wallets).where(eq(wallets.id, stable.wallet.id)))[0]).toEqual(stable.wallet);
  });

  it('A-9 a changed mirror aborts the entire apply transaction', async () => {
    const first = await seed();
    const second = await seed();
    const store = createMigrationStore(db);
    const observed = (await store.listCandidates()).filter((row) => [first.user.id, second.user.id].includes(row.id));
    await db.update(subscriptions).set({ stripePriceId: retiredPriceId }).where(eq(subscriptions.userId, second.user.id));
    await expect(store.apply(observed.map((user) => ({ user, tier: 'pro' as const })), observed)).rejects.toThrow('evidence changed');
    const rows = await db.select().from(users).where(inArray(users.id, [first.user.id, second.user.id]));
    expect(rows.map((user) => user.subscriptionTier)).toEqual(['founder', 'founder']);
    expect((await db.select().from(wallets).where(eq(wallets.id, first.wallet.id)))[0]).toEqual(first.wallet);
  });
});
