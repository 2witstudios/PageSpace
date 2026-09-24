/**
 * The wallet-aware credit gate against a real Postgres (Spec WAL-5, WAL-6, WAL-8, SPEND-1,
 * SPEND-4, SPEND-8): the REAL canConsumeAI and consumeCredits, with ORGS_ENABLED on, over a
 * small Northwind (Sequence Spec fixture): the org pool, Product's drive wallet under it,
 * Marcus (a free-tier member with his own credits) and Chris Rowe (a guest on Product).
 *
 * What must hold: the call names one wallet before it runs; the hold is placed on that
 * wallet and the charge settles against it (the allocation drawn from the pool); an empty
 * chosen wallet refuses, names it, offers the rest, reserves nothing and charges nothing —
 * above all never Marcus's own credits; overshoot lands on the pool, never the consumer.
 *
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one (requireDb).
 * Deletes every row it creates, children before parents, users last, and ends the pool.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { loggers } from '../../logging/logger-config';
import { canConsumeAI } from '../credit-gate';
import { consumeCredits } from '../credit-consume';
import { PERSONAL_SPEND, driveSpend } from '../spend-target';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

// A pass-through of the real resolution with a seam AFTER it returns: a test can change the
// world between the unlocked resolution and gateSharedWallet's locked re-read (SPEND-4).
const afterResolution = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
vi.mock('../spend-resolution', async (importOriginal) => {
  const real = await importOriginal<typeof import('../spend-resolution')>();
  return {
    ...real,
    resolveCallSpend: async (...args: Parameters<typeof real.resolveCallSpend>) => {
      const decision = await real.resolveCallSpend(...args);
      if (afterResolution.run) await afterResolution.run();
      return decision;
    },
  };
});

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

interface World {
  orgId: string;
  productId: string;
  marcusId: string;
  chrisId: string;
  jonoId: string;
  poolId: string;
  productWalletId: string;
  marcusWalletId: string;
  userIds: string[];
}

let world: World | null = null;

async function build(input: { productAllocationCents: number; poolCents: number; productStatus?: 'active' | 'paused' }): Promise<World> {
  const jono = await factories.createUser({ name: 'Jono', subscriptionTier: 'free' });
  const marcus = await factories.createUser({ name: 'Marcus Oyelaran', subscriptionTier: 'free' });
  const chris = await factories.createUser({ name: 'Chris Rowe', subscriptionTier: 'free' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id }).returning();
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(jono.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
  await factories.createDriveMember(product.id, chris.id, { source: 'invite' });

  const [poolWallet] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: input.poolCents }).returning();
  const [productWallet] = await db.insert(wallets).values({
    ownerType: 'org',
    orgId: org.id,
    subjectType: 'drive',
    subjectId: product.id,
    parentWalletId: poolWallet.id,
    monthlyAllowanceCents: input.productAllocationCents,
    status: input.productStatus ?? 'active',
  }).returning();
  // Marcus's own credits: funded, with a stamped period so the gate does not grant into it.
  const [marcusWallet] = await db.insert(wallets).values({
    userId: marcus.id,
    monthlyRemainingCents: 5_000,
    monthlyAllowanceCents: 5_000,
    monthlyPeriodStart: new Date(),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  return {
    orgId: org.id,
    productId: product.id,
    marcusId: marcus.id,
    chrisId: chris.id,
    jonoId: jono.id,
    poolId: poolWallet.id,
    productWalletId: productWallet.id,
    marcusWalletId: marcusWallet.id,
    userIds: [jono.id, marcus.id, chris.id],
  };
}

async function teardown(w: World): Promise<void> {
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  // Child wallets before their parent (parentWalletId has no cascade), then the rest.
  await db.delete(wallets).where(eq(wallets.parentWalletId, w.poolId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(drives).where(eq(drives.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const walletRow = async (id: string) => (await db.select().from(wallets).where(eq(wallets.id, id)))[0];
const holdsOf = (userId: string) => db.select().from(creditHolds).where(eq(creditHolds.userId, userId));
const ledgerOf = (userId: string) => db.select().from(creditLedger).where(eq(creditLedger.userId, userId));

describe('the wallet-aware credit gate (orgs on, real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('wallet-gate.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  beforeEach(() => {
    process.env.DEPLOYMENT_MODE = 'cloud';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    afterResolution.run = null;
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (world) await teardown(world);
    world = null;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('SPEND-4 (partial) X-6 (partial) an empty chosen drive wallet refuses, names it, offers the rest, reserves nothing and charges nothing — never the person', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 0, poolCents: 5_000 });
    const info = vi.spyOn(loggers.ai, 'info');

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: driveSpend(world.productId, 'drive_wallet') });

    expect(gate).toEqual({
      allowed: false,
      reason: 'source_refused',
      refusal: { source: 'drive_wallet', reason: 'source_empty', options: ['seat_allowance', 'own_credits'] },
    });
    // The refusal is recorded, naming the source and the options offered instead.
    expect(info).toHaveBeenCalledWith('spend source refused', expect.objectContaining({
      userId: world.marcusId,
      driveId: world.productId,
      source: 'drive_wallet',
      reason: 'source_empty',
      options: ['seat_allowance', 'own_credits'],
    }));
    expect(await holdsOf(world.marcusId)).toEqual([]);
    expect(await ledgerOf(world.marcusId)).toEqual([]);
    expect((await walletRow(world.marcusWalletId)).monthlyRemainingCents).toBe(5_000);
    expect((await walletRow(world.poolId)).monthlyRemainingCents).toBe(5_000);
  });

  it('SPEND-4 (partial) with several sources and none chosen the gate refuses rather than picking one', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: driveSpend(world.productId, null) });

    expect(gate).toMatchObject({ allowed: false, reason: 'source_refused', refusal: { source: null, reason: 'no_source_chosen' } });
    expect(await holdsOf(world.marcusId)).toEqual([]);
  });

  it('SPEND-4 (partial) a paused chosen wallet refuses and reserves nothing', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000, productStatus: 'paused' });

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: driveSpend(world.productId, 'drive_wallet') });

    expect(gate).toMatchObject({ allowed: false, reason: 'source_refused', refusal: { source: 'drive_wallet', reason: 'source_paused' } });
    expect(await holdsOf(world.marcusId)).toEqual([]);
  });

  it('SPEND-4 (partial) a wallet paused after resolution named it is refused under the lock and reserves nothing', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    // The unlocked resolution sees an active wallet and names it; the funder pauses it
    // before the gate takes the row lock. Only the locked re-read can catch that.
    afterResolution.run = async () => {
      await db.update(wallets).set({ status: 'paused' }).where(eq(wallets.id, w.productWalletId));
    };

    const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet') });

    expect(gate).toEqual({
      allowed: false,
      reason: 'source_refused',
      refusal: { source: 'drive_wallet', reason: 'source_paused', options: [] },
    });
    expect(await holdsOf(w.marcusId)).toEqual([]);
  });

  it('SPEND-4 (partial) a guest who chose the drive wallet is refused with only their own credits offered', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });

    const gate = await canConsumeAI(world.chrisId, 'free', { spend: driveSpend(world.productId, 'drive_wallet') });

    expect(gate).toMatchObject({
      allowed: false,
      reason: 'source_refused',
      refusal: { source: 'drive_wallet', reason: 'guest_drive_wallet_off', options: ['own_credits'] },
    });
    expect(await holdsOf(world.chrisId)).toEqual([]);
  });

  it('WAL-5 (partial) SPEND-1 (partial) the chosen drive wallet holds the reservation and settles the charge; the allocation is drawn from the pool', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: driveSpend(world.productId, 'drive_wallet') });
    expect(gate).toMatchObject({ allowed: true, walletId: world.productWalletId, spendSource: 'drive_wallet' });
    const held = await holdsOf(world.marcusId);
    expect(held.map((h) => h.walletId)).toEqual([world.productWalletId]);

    const [log] = await db.insert(aiUsageLogs).values({ userId: world.marcusId, provider: 'openrouter', model: 'm', cost: 0.1 }).returning({ id: aiUsageLogs.id });
    const status = await consumeCredits({ aiUsageLogId: log.id, userId: world.marcusId, costDollars: 0.1, holdId: gate.holdId, walletId: gate.walletId });
    expect(status).toBe('settled');

    // $0.10 at the 1.5× markup is 15¢: drawn from Product's allocation, which the pool funds.
    expect((await walletRow(world.productWalletId)).spentCents).toBe(15);
    expect((await walletRow(world.poolId)).monthlyRemainingCents).toBe(5_000 - 15);
    expect((await walletRow(world.marcusWalletId)).monthlyRemainingCents).toBe(5_000);
    const ledger = await ledgerOf(world.marcusId);
    expect(ledger.map((r) => [r.entryType, r.walletId, r.appliedCents])).toEqual([['usage', world.productWalletId, -15]]);
    const [usage] = await db.select({ walletId: aiUsageLogs.walletId }).from(aiUsageLogs).where(eq(aiUsageLogs.id, log.id));
    expect(usage.walletId).toBe(world.productWalletId);
    expect(await holdsOf(world.marcusId)).toEqual([]);
  });

  it('WAL-6 (partial) a covered reservation that overshoots lands the overshoot on the pool as debt, never on the consumer', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 60, poolCents: 5_000 });

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: driveSpend(world.productId, 'drive_wallet') });
    expect(gate.allowed).toBe(true);
    const [log] = await db.insert(aiUsageLogs).values({ userId: world.marcusId, provider: 'openrouter', model: 'm', cost: 1 }).returning({ id: aiUsageLogs.id });
    await consumeCredits({ aiUsageLogId: log.id, userId: world.marcusId, costDollars: 1, holdId: gate.holdId, walletId: gate.walletId });

    // 150¢ charged: the 60¢ allocation, then 90¢ uncovered, absorbed into the pool's debt (D20.2).
    const product = await walletRow(world.productWalletId);
    const poolRow = await walletRow(world.poolId);
    expect(product.spentCents).toBe(60);
    expect(product.debtCents).toBe(0);
    expect(poolRow.monthlyRemainingCents).toBe(5_000 - 60);
    expect(poolRow.debtCents).toBe(90);
    const marcusRow = await walletRow(world.marcusWalletId);
    expect([marcusRow.monthlyRemainingCents, marcusRow.debtCents]).toEqual([5_000, 0]);
    const debt = (await ledgerOf(world.marcusId)).filter((r) => r.entryType === 'adjustment');
    expect(debt.map((r) => [r.walletId, r.amountCents])).toEqual([[world.poolId, -90]]);
  });

  it('WAL-5 (partial) a seat spends the org pool; WAL-8 (partial) a free member on an org leg carries the org tier', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: driveSpend(world.productId, 'seat_allowance') });

    expect(gate).toMatchObject({ allowed: true, walletId: world.poolId, spendSource: 'seat_allowance', entitlementTier: 'business' });
    expect((await holdsOf(world.marcusId)).map((h) => h.walletId)).toEqual([world.poolId]);
  });

  it('WAL-8 (partial) the same free member on their own credits keeps their own tier and holds on their own wallet', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: driveSpend(world.productId, 'own_credits') });

    expect(gate).toMatchObject({ allowed: true, walletId: world.marcusWalletId, spendSource: 'own_credits', entitlementTier: 'free' });
    expect((await holdsOf(world.marcusId)).map((h) => h.walletId)).toEqual([world.marcusWalletId]);
  });

  it('SPEND-8 (partial) a call with no drive spends the personal root wallet, orgs on', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: PERSONAL_SPEND });

    expect(gate).toMatchObject({ allowed: true, walletId: world.marcusWalletId, spendSource: 'own_credits' });
  });

  it('WAL-6 (partial) a drive wallet is never reserved past what it can cover: its holds count against it', async () => {
    if (!dbAvailable) return;
    // 60¢ allocation: one 25¢ reservation leaves 35¢, and a second would leave 10¢ — at or
    // under the 25¢ reserve floor — so it is refused as out of credits, not moved elsewhere.
    world = await build({ productAllocationCents: 60, poolCents: 5_000 });
    const first = await canConsumeAI(world.marcusId, 'pro', { spend: driveSpend(world.productId, 'drive_wallet') });
    expect(first.allowed).toBe(true);

    const second = await canConsumeAI(world.marcusId, 'pro', { spend: driveSpend(world.productId, 'drive_wallet') });

    expect(second.allowed).toBe(false);
    expect((await holdsOf(world.marcusId)).map((h) => h.walletId)).toEqual([world.productWalletId]);
  });
});
