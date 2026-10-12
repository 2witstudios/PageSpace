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
import { and, eq, inArray, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { conversations } from '@pagespace/db/schema/conversations';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { creditHolds, creditLedger, type SpendKind } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { driveSpendOverrides, personalRootWalletOf, walletConsumerCaps, walletDebtNotices, walletFundingLegs, wallets } from '@pagespace/db/schema/wallets';
import { notifications } from '@pagespace/db/schema/notifications';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { loggers } from '../../logging/logger-config';
import { canConsumeAI } from '../credit-gate';
import { consumeCredits, recordSeatOvershoot, releaseHold, settlePendingLedgerRow } from '../credit-consume';
import { computeBackfillActions } from '../credit-core';
import { PERSONAL_SPEND, conversationSpend, driveSpend, resolvedSpend, spendFallbackFromWalletId } from '../spend-target';
import { DEFAULT_SEAT_ALLOWANCE_CENTS } from '../wallet-core';
import { loadSeatCapFacts } from '../seat-allowance';
import { applyOrgPoolRefill, donateToDriveWallet, resetDueAllocations } from '../wallet-funding-shell';
import { reconcileOpenRouterCosts } from '../cost-reconcile';
import { createDriveWallet, getConversationSpend, getDriveWallet, setConversationSpend, topUpDriveWallet } from '../../services/drive-wallet-service';
import { walletDriftAlerts } from '../wallet-reconcile';
import { pinConversationSource } from '../spend-resolution';
import { gateComputeCharge } from '../compute-gate';
import { computeChargeFor, driveAccrualChargeFor } from '../compute-charge';
import { expectWalletLegInvariant } from '../../test/wallet-leg-invariant';

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
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id, stripeCustomerId: `cus_${createId()}` }).returning();
  // Northwind has paid: there is no org trial (D-OW-30), and an unpaid org's legs read as paused.
  await factories.createOrgSubscription(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(jono.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
  await factories.createDriveMember(product.id, chris.id, { source: 'invite' });

  // The pool refilled ten days ago: its period (the seat cap's clock, D-OW-12) started then.
  const [poolWallet] = await db.insert(wallets).values({
    ownerType: 'org',
    orgId: org.id,
    monthlyRemainingCents: input.poolCents,
    monthlyPeriodStart: new Date(Date.now() - 10 * 86_400_000),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
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
  await db.delete(notifications).where(inArray(notifications.userId, w.userIds));
  await db.delete(driveSpendOverrides).where(inArray(driveSpendOverrides.userId, w.userIds));
  await db.delete(conversations).where(inArray(conversations.userId, w.userIds));
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  // Child wallets before their parent (parentWalletId has no cascade), then the rest.
  await db.delete(walletConsumerCaps).where(eq(walletConsumerCaps.walletId, w.poolId));
  await db.delete(wallets).where(eq(wallets.parentWalletId, w.poolId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(drives).where(eq(drives.orgId, w.orgId));
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const REFILL_PRICE_ID = 'price_test_org_base';
const REFILL_SEAT_PRICE_ID = 'price_test_org_seat';
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

  it('SPEND-3 (partial) with several sources, none chosen and no default set, the gate spends the drive\'s wallet (the out-of-box default), never the person', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: driveSpend(world.productId, null) });

    expect(gate).toMatchObject({ allowed: true, walletId: world.productWalletId, spendSource: 'drive_wallet' });
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
    expect(ledger.map((r) => [r.entryType, r.walletId, r.appliedCents]).sort()).toEqual([
      ['allocation_draw', world.poolId, -15], ['allocation_draw', world.productWalletId, 15], ['usage', world.productWalletId, -15],
    ].sort());
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

  /**
   * Gate Marcus on Product's wallet and settle at `costDollars`: more than the allocation left
   * overshoots. Each call first restores the allocation's room, so a later call is admitted again.
   */
  async function driveWalletCall(w: World, costDollars: number) {
    await db.update(wallets).set({ spentCents: 0 }).where(eq(wallets.id, w.productWalletId));
    const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet') });
    expect(gate.allowed).toBe(true);
    const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: costDollars }).returning({ id: aiUsageLogs.id });
    expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');
  }
  const debtNoticesFor = (userId: string) =>
    db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, 'WALLET_DEBT')));
  async function addOrgAdmin(w: World): Promise<string> {
    const ana = await factories.createUser({ name: 'Ana Admin', subscriptionTier: 'free' });
    w.userIds.push(ana.id);
    await db.insert(orgMembers).values({ orgId: w.orgId, userId: ana.id, role: 'ADMIN' });
    return ana.id;
  }

  it('WAL-6 (partial) a drive wallet whose funder chose wallet_debt carries its own overshoot — never the pool, never the consumer', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 60, poolCents: 5_000 });
    await db.update(wallets).set({ overshootChoice: 'wallet_debt' }).where(eq(wallets.id, world.productWalletId));

    await driveWalletCall(world, 1);

    // 150¢: the 60¢ allocation from the pool, then 90¢ uncovered — carried by Product itself.
    const product = await walletRow(world.productWalletId);
    const poolRow = await walletRow(world.poolId);
    expect([product.spentCents, product.debtCents]).toEqual([60, 90]);
    expect([poolRow.monthlyRemainingCents, poolRow.debtCents]).toEqual([5_000 - 60, 0]);
    expect((await walletRow(world.marcusWalletId)).debtCents).toBe(0);
    const debt = (await ledgerOf(world.marcusId)).filter((r) => r.entryType === 'adjustment');
    expect(debt.map((r) => [r.walletId, r.amountCents])).toEqual([[world.productWalletId, -90]]);
  });

  it('WAL-6 (partial) the funder of a wallet in debt is told ONCE per period, in-app: the org Owner and Admins, never the member who spent', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 60, poolCents: 5_000 });
    const w = world;
    const anaId = await addOrgAdmin(w);

    // Two overshooting calls in one pool period: the pool carries the debt (the default), and its
    // funders hear about it once.
    await driveWalletCall(w, 1);
    await driveWalletCall(w, 1);

    for (const funder of [w.jonoId, anaId]) {
      const notices = await debtNoticesFor(funder);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ type: 'WALLET_DEBT', isRead: false, metadata: { walletId: w.poolId } });
    }
    expect(await debtNoticesFor(w.marcusId)).toEqual([]);
    expect(await debtNoticesFor(w.chrisId)).toEqual([]);

    // A new period (the last notice predates the pool's period start): the next overshoot tells them again.
    const poolPeriodStart = (await walletRow(w.poolId)).monthlyPeriodStart as Date;
    await db.update(walletDebtNotices).set({ lastNotifiedAt: new Date(poolPeriodStart.getTime() - 60_000) }).where(eq(walletDebtNotices.walletId, w.poolId));
    await driveWalletCall(w, 1);
    expect(await debtNoticesFor(w.jonoId)).toHaveLength(2);
  });

  it('WAL-6 (partial) a drive wallet carrying its own debt: its funder (the pool\'s Owner) is told about THAT wallet and drive', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 60, poolCents: 5_000 });
    await db.update(wallets).set({ overshootChoice: 'wallet_debt' }).where(eq(wallets.id, world.productWalletId));

    await driveWalletCall(world, 1);

    expect(await debtNoticesFor(world.jonoId)).toEqual([expect.objectContaining({ metadata: { walletId: world.productWalletId }, driveId: world.productId })]);
    expect(await debtNoticesFor(world.marcusId)).toEqual([]);
  });

  it('WAL-6 (partial) a person overshooting their OWN credits is no funder\'s notice: nobody is told', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 60, poolCents: 5_000 });
    const gate = await canConsumeAI(world.marcusId, 'free', { spend: driveSpend(world.productId, 'own_credits') });
    expect(gate).toMatchObject({ allowed: true, walletId: world.marcusWalletId });
    const [log] = await db.insert(aiUsageLogs).values({ userId: world.marcusId, provider: 'openrouter', model: 'm', cost: 40 }).returning({ id: aiUsageLogs.id });
    expect(await consumeCredits({ aiUsageLogId: log.id, userId: world.marcusId, costDollars: 40, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');

    expect((await walletRow(world.marcusWalletId)).debtCents).toBeGreaterThan(0);
    for (const userId of world.userIds) expect(await debtNoticesFor(userId)).toEqual([]);
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

  it('SPEND-8 the global assistant with no drive spends personal credits: its no-drive turn target reserves and settles on the caller\'s personal root, whatever drive wallet, seat or stored choice they have elsewhere — none is read or touched', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    // Marcus is a member of a funded org drive, with a seat, and his global conversation even stores the drive wallet.
    const [globalConv] = await db.insert(conversations).values({ userId: w.marcusId, type: 'global', chosenWalletId: w.productWalletId, updatedAt: new Date() }).returning({ id: conversations.id });
    // What the global turn names with no server-resolved drive (no contextRef): the personal target.
    const target = conversationSpend(null, globalConv.id);
    expect(target).toEqual(PERSONAL_SPEND);

    const gate = await canConsumeAI(w.marcusId, 'free', { spend: target });
    expect(gate).toMatchObject({ allowed: true, walletId: w.marcusWalletId, spendSource: 'own_credits' });
    expect((await holdsOf(w.marcusId)).map((h) => h.walletId)).toEqual([w.marcusWalletId]);
    const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 0.1 }).returning({ id: aiUsageLogs.id });
    expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 0.1, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');

    // 15¢ off his own credits; the drive wallet, the pool and the stored choice untouched.
    expect((await walletRow(w.marcusWalletId)).monthlyRemainingCents).toBe(5_000 - 15);
    expect((await walletRow(w.productWalletId)).spentCents).toBe(0);
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(5_000);
    expect((await ledgerOf(w.marcusId)).map((r) => [r.entryType, r.walletId, r.appliedCents])).toEqual([['usage', w.marcusWalletId, -15]]);
    const [usage] = await db.select({ walletId: aiUsageLogs.walletId }).from(aiUsageLogs).where(eq(aiUsageLogs.id, log.id));
    expect(usage.walletId).toBe(w.marcusWalletId);
    expect(await holdsOf(w.marcusId)).toEqual([]);
    expect((await db.select({ id: conversations.chosenWalletId }).from(conversations).where(eq(conversations.id, globalConv.id)))[0].id).toBe(w.productWalletId);
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
  // ---------------------------------------------------------------------------
  // The stored choice (conversations.chosenWalletId, wallets.defaultSpendSource): a stored
  // wallet that no longer resolves for this person refuses by name and charges nothing.
  // ---------------------------------------------------------------------------

  /** A drive conversation of `userId` in `driveId`, with `chosenWalletId` stored on it. */
  async function conversationIn(driveId: string, userId: string, chosenWalletId: string | null): Promise<string> {
    const [row] = await db
      .insert(conversations)
      .values({ userId, type: 'drive', contextId: driveId, chosenWalletId, updatedAt: new Date() })
      .returning({ id: conversations.id });
    return row.id;
  }

  /** Nothing moved: no hold, no ledger row, Marcus's own wallet and the pool untouched. */
  async function expectNothingCharged(w: World): Promise<void> {
    expect(await holdsOf(w.marcusId)).toEqual([]);
    expect(await ledgerOf(w.marcusId)).toEqual([]);
    expect((await walletRow(w.marcusWalletId)).monthlyRemainingCents).toBe(5_000);
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(5_000);
  }

  it('SPEND-3 (partial) a conversation whose chosen wallet is valid spends exactly that wallet, turn after turn', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const conversationId = await conversationIn(world.productId, world.marcusId, world.poolId);

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: conversationSpend(world.productId, conversationId) });

    expect(gate).toMatchObject({ allowed: true, walletId: world.poolId, spendSource: 'seat_allowance' });
  });

  it('SPEND-4 (partial) X-6 (partial) a conversation whose chosen wallet was DELETED refuses by name and charges zero — no fallback to the personal root', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const conversationId = await conversationIn(world.productId, world.marcusId, world.productWalletId);
    // Even Marcus's own default names his own credits: the stale choice still wins and refuses.
    await db.update(wallets).set({ defaultSpendSource: 'own_credits' }).where(eq(wallets.id, world.marcusWalletId));
    await db.delete(wallets).where(eq(wallets.id, world.productWalletId));

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: conversationSpend(world.productId, conversationId) });

    expect(gate).toEqual({
      allowed: false,
      reason: 'source_refused',
      refusal: { source: null, reason: 'chosen_wallet_unavailable', options: ['seat_allowance', 'own_credits'] },
    });
    await expectNothingCharged(world);
  });

  it('SPEND-4 (partial) a chosen wallet that is someone else\'s personal wallet refuses the same way', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const [jonoWallet] = await db.insert(wallets).values({ userId: world.jonoId, monthlyRemainingCents: 9_000 }).returning();
    const conversationId = await conversationIn(world.productId, world.marcusId, jonoWallet.id);

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: conversationSpend(world.productId, conversationId) });

    expect(gate).toMatchObject({ allowed: false, reason: 'source_refused', refusal: { source: null, reason: 'chosen_wallet_unavailable' } });
    await expectNothingCharged(world);
    expect((await walletRow(jonoWallet.id)).monthlyRemainingCents).toBe(9_000);
  });

  it('SPEND-4 (partial) X-6 (partial) an org member WITHOUT membership of a Restricted org drive cannot spend its wallet or a seat there — not by stored wallet id, not by naming the source', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    // Customer Research is Restricted: Marcus is in the org but has not joined it.
    const research = await factories.createDrive(world.jonoId, { name: 'Customer Research', slug: `research-${createId()}`, orgId: world.orgId, orgVisibility: 'RESTRICTED' });
    const [researchWallet] = await db.insert(wallets).values({
      ownerType: 'org', orgId: world.orgId, subjectType: 'drive', subjectId: research.id, parentWalletId: world.poolId, monthlyAllowanceCents: 600,
      // Its drive default names the drive wallet: a default is no key either.
      defaultSpendSource: 'drive_wallet',
    }).returning();

    const byWalletId = await canConsumeAI(world.marcusId, 'free', { spend: conversationSpend(research.id, await conversationIn(research.id, world.marcusId, researchWallet.id)) });
    expect(byWalletId).toMatchObject({ allowed: false, reason: 'source_refused', refusal: { source: null, reason: 'chosen_wallet_unavailable', options: ['own_credits'] } });

    const byPoolId = await canConsumeAI(world.marcusId, 'free', { spend: conversationSpend(research.id, await conversationIn(research.id, world.marcusId, world.poolId)) });
    expect(byPoolId).toMatchObject({ allowed: false, reason: 'source_refused', refusal: { source: null, reason: 'chosen_wallet_unavailable', options: ['own_credits'] } });

    for (const source of ['drive_wallet', 'seat_allowance'] as const) {
      const bySource = await canConsumeAI(world.marcusId, 'free', { spend: driveSpend(research.id, source) });
      expect(bySource, source).toMatchObject({ allowed: false, reason: 'source_refused', refusal: { source, reason: 'source_unavailable', options: ['own_credits'] } });
    }
    await expectNothingCharged(world);
    expect((await walletRow(researchWallet.id)).spentCents).toBe(0);
  });

  it('D-OW-24 an org member holding only a GUEST row (a redeemed page share link) on a Restricted drive cannot spend its wallet or a seat there; the same row as MEMBER can', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const research = await factories.createDrive(world.jonoId, { name: 'Customer Research', slug: `research-${createId()}`, orgId: world.orgId, orgVisibility: 'RESTRICTED' });
    const [researchWallet] = await db.insert(wallets).values({
      ownerType: 'org', orgId: world.orgId, subjectType: 'drive', subjectId: research.id, parentWalletId: world.poolId, monthlyAllowanceCents: 600,
    }).returning();
    await factories.createDriveMember(research.id, world.marcusId, { source: 'invite', role: 'GUEST' });

    for (const source of ['drive_wallet', 'seat_allowance'] as const) {
      const bySource = await canConsumeAI(world.marcusId, 'free', { spend: driveSpend(research.id, source) });
      expect(bySource, source).toMatchObject({ allowed: false, reason: 'source_refused', refusal: { source, reason: 'source_unavailable', options: ['own_credits'] } });
    }
    await expectNothingCharged(world);
    expect((await walletRow(researchWallet.id)).spentCents).toBe(0);

    // Positive control: the same row as a MEMBER opens the drive wallet.
    await db.update(driveMembers).set({ role: 'MEMBER' }).where(and(eq(driveMembers.driveId, research.id), eq(driveMembers.userId, world.marcusId)));
    const asMember = await canConsumeAI(world.marcusId, 'free', { spend: driveSpend(research.id, 'drive_wallet') });
    expect(asMember).toMatchObject({ allowed: true, walletId: researchWallet.id });
  });

  it('SPEND-3 (partial) a conversation with nothing chosen and no default set spends the drive\'s wallet out of the box', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const conversationId = await conversationIn(world.productId, world.marcusId, null);

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: conversationSpend(world.productId, conversationId) });

    expect(gate).toMatchObject({ allowed: true, walletId: world.productWalletId, spendSource: 'drive_wallet' });
  });

  it('SPEND-3 (partial) with nothing chosen the drive default preselects before the person\'s default', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const conversationId = await conversationIn(world.productId, world.marcusId, null);
    await db.update(wallets).set({ defaultSpendSource: 'own_credits' }).where(eq(wallets.id, world.marcusWalletId));

    const personal = await canConsumeAI(world.marcusId, 'free', { spend: conversationSpend(world.productId, conversationId) });
    expect(personal).toMatchObject({ allowed: true, walletId: world.marcusWalletId, spendSource: 'own_credits' });

    // A NEW conversation after the drive sets a default: the drive's default wins. (The first
    // conversation keeps the source its first call pinned — see the SPEND-3 scenario.)
    await db.update(wallets).set({ defaultSpendSource: 'drive_wallet' }).where(eq(wallets.id, world.productWalletId));
    const next = await conversationIn(world.productId, world.marcusId, null);
    const drive = await canConsumeAI(world.marcusId, 'free', { spend: conversationSpend(world.productId, next) });
    expect(drive).toMatchObject({ allowed: true, walletId: world.productWalletId, spendSource: 'drive_wallet' });
  });
  it('SPEND-3 (partial) a stored choice is read only from the caller\'s OWN conversation: naming someone else\'s conversation chooses nothing', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    // Jono's conversation in Product stores the org pool, which is also Marcus's seat.
    const jonosConversation = await conversationIn(world.productId, world.jonoId, world.poolId);

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: conversationSpend(world.productId, jonosConversation) });

    // Jono's choice is not read for Marcus: he spends what he would with nothing chosen (the drive's wallet), not the seat.
    expect(gate).toMatchObject({ allowed: true, walletId: world.productWalletId, spendSource: 'drive_wallet' });
  });

  // ---------------------------------------------------------------------------
  // WAL-2: a seat is the per-consumer monthly cap on the pool's own leg. With a full pool,
  // one member still spends no more than their own allowance this pool period.
  // ---------------------------------------------------------------------------

  /** $0.1666667 at the 1.5× markup charges exactly 25¢ (25,000 millicents): one reservation's worth. */
  const COST_25C = 0.1666667;

  /**
   * Gate a seat call for `userId`, then settle it at 25¢. Returns the gate answer. With a
   * `generationId` the usage log waits for the cost-reconcile cron, as an OpenRouter call does.
   */
  async function seatCall(w: World, userId: string, generationId?: string, tier: 'free' | 'pro' = 'free') {
    const gate = await canConsumeAI(userId, tier, { spend: driveSpend(w.productId, 'seat_allowance') });
    if (!gate.allowed) return gate;
    const reconcile = generationId
      ? { timestamp: new Date(Date.now() - 10 * 60_000), reconcileStatus: 'pending', reconcileAttempts: 0, metadata: { generationIds: [generationId] } }
      : {};
    const [log] = await db.insert(aiUsageLogs).values({ userId, provider: 'openrouter', model: 'm', cost: COST_25C, ...reconcile }).returning({ id: aiUsageLogs.id });
    const status = await consumeCredits({ aiUsageLogId: log.id, userId, costDollars: COST_25C, holdId: gate.holdId, walletId: gate.walletId });
    expect(status).toBe('settled');
    return gate;
  }

  /** What `userId` has been charged on the pool (usage rows), in whole cents. */
  async function seatChargedCents(w: World, userId: string): Promise<number> {
    const rows = await db.select().from(creditLedger).where(and(eq(creditLedger.walletId, w.poolId), eq(creditLedger.userId, userId), eq(creditLedger.entryType, 'usage')));
    return rows.reduce((sum, r) => sum - (r.appliedCents ?? 0), 0);
  }

  async function addLena(w: World): Promise<string> {
    const lena = await factories.createUser({ name: 'Lena Schulz', subscriptionTier: 'free' });
    w.userIds.push(lena.id);
    await db.insert(orgMembers).values({ orgId: w.orgId, userId: lena.id, role: 'MEMBER' });
    await factories.createDriveMember(w.productId, lena.id, { source: 'org' });
    return lena.id;
  }

  it('WAL-2 (partial) with a FULL pool one member spends no more than their monthly seat allowance, then is refused by the cap and charged nothing', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    expect(DEFAULT_SEAT_ALLOWANCE_CENTS).toBe(100);

    // 100¢ allowance at 25¢ a call: four calls fit exactly, the fifth does not.
    for (let call = 1; call <= 4; call += 1) {
      expect(await seatCall(w, w.marcusId), `call ${call}`).toMatchObject({ allowed: true, walletId: w.poolId, spendSource: 'seat_allowance' });
    }
    const ledgerBefore = (await ledgerOf(w.marcusId)).length;

    const fifth = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'seat_allowance') });

    expect(fifth).toEqual({
      allowed: false,
      reason: 'source_refused',
      refusal: { source: 'seat_allowance', reason: 'source_cap_reached', options: ['drive_wallet', 'own_credits'] },
    });
    expect(await holdsOf(w.marcusId)).toEqual([]);
    expect((await ledgerOf(w.marcusId)).length).toBe(ledgerBefore);
    expect(await seatChargedCents(w, w.marcusId)).toBe(100);
    // The pool paid exactly the allowance and holds the rest; Marcus's own credits are untouched.
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(900_000 - 100);
    expect((await walletRow(w.marcusWalletId)).monthlyRemainingCents).toBe(5_000);
  });

  /**
   * Force GENUINE overlap of two gate calls: while `fn` runs, every hold INSERT for `userId` sleeps
   * inside Postgres. Without the pool row lock a second gate then reads the seat's usage in the
   * window between the first gate's read and its insert, sees no hold, and both pass — every run, not
   * one run in four. With the lock the second gate waits for the first to commit and sees its hold.
   */
  async function withSlowHoldInserts<T>(userId: string, fn: () => Promise<T>, ms = 400): Promise<T> {
    const name = `test_slow_hold_${createId().slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    await db.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(${ms / 1000}); RETURN NEW; END $$ LANGUAGE plpgsql`));
    await db.execute(sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT ON credit_holds FOR EACH ROW WHEN (NEW."userId" = '${userId}') EXECUTE FUNCTION ${name}()`));
    try {
      return await fn();
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON credit_holds`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${name}()`));
    }
  }

  it('WAL-2 (partial) calls in flight count against the seat allowance: concurrent reservations cannot pass the cap together', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;

    const gates = await withSlowHoldInserts(w.marcusId, () => Promise.all(Array.from({ length: 6 }, () => canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') }))), 150);

    expect(gates.filter((g) => g.allowed)).toHaveLength(4);
    expect(gates.filter((g) => !g.allowed).every((g) => g.refusal?.reason === 'source_cap_reached')).toBe(true);
    const held = await holdsOf(w.marcusId);
    expect(held.reduce((sum, h) => sum + h.estCents, 0)).toBe(100);
  });

  it('WAL-2 (partial) two SIMULTANEOUS seat calls against an allowance with room for one: exactly one passes', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    // 75¢ already spent of 100¢: room for one 25¢ reservation.
    for (let call = 0; call < 3; call += 1) await seatCall(w, w.marcusId);

    const both = await withSlowHoldInserts(w.marcusId, () => Promise.all([0, 1].map(() => canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') }))));

    expect(both.filter((g) => g.allowed)).toHaveLength(1);
    expect(both.find((g) => !g.allowed)).toMatchObject({ reason: 'source_refused', refusal: { source: 'seat_allowance', reason: 'source_cap_reached' } });
    expect((await holdsOf(w.marcusId)).map((h) => [h.walletId, h.estCents])).toEqual([[w.poolId, 25]]);
  });

  it('WAL-2 (partial) the cap is decided under the pool lock: spend landing after the unlocked resolution saw room is still refused', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    for (let call = 0; call < 3; call += 1) await seatCall(w, w.marcusId);
    // The resolution sees 25¢ of room and names the seat; before the gate locks the pool,
    // another of Marcus's calls settles its last 25¢ onto the pool.
    afterResolution.run = async () => {
      afterResolution.run = null;
      await seatCall(w, w.marcusId);
    };

    const gate = await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') });

    expect(gate).toEqual({ allowed: false, reason: 'source_refused', refusal: { source: 'seat_allowance', reason: 'source_cap_reached', options: [] } });
    expect(await holdsOf(w.marcusId)).toEqual([]);
    expect(await seatChargedCents(w, w.marcusId)).toBe(100);
  });

  it('WAL-2 (partial) only calls in flight on the SEAT count against it: the same member\'s drive-wallet calls in flight leave the allowance whole', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    for (let call = 0; call < 4; call += 1) {
      expect(await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'drive_wallet') })).toMatchObject({ allowed: true, walletId: w.productWalletId });
    }

    for (let call = 1; call <= 4; call += 1) {
      // Pro: the free tier's in-flight cap would count the drive calls; the seat cap must not.
      expect(await seatCall(w, w.marcusId, undefined, 'pro'), `seat call ${call}`).toMatchObject({ allowed: true, walletId: w.poolId });
    }
    expect(await seatChargedCents(w, w.marcusId)).toBe(100);
  });

  it('WAL-2 (partial) only SETTLED spend on the seat counts against it: the same member\'s settled drive-wallet and own-credits spend leave the allowance whole', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    // 100¢ settled on Product's wallet and 100¢ on his own credits: 200¢ of Marcus's spend, none of it the seat.
    for (const source of ['drive_wallet', 'drive_wallet', 'own_credits', 'own_credits'] as const) {
      const gate = await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, source) });
      expect(gate, source).toMatchObject({ allowed: true });
      const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 2 * COST_25C }).returning({ id: aiUsageLogs.id });
      expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 2 * COST_25C, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');
    }
    expect((await ledgerOf(w.marcusId)).filter((r) => r.entryType === 'usage' && r.walletId !== w.poolId)).toHaveLength(4);

    for (let call = 1; call <= 4; call += 1) {
      expect(await seatCall(w, w.marcusId, undefined, 'pro'), `seat call ${call}`).toMatchObject({ allowed: true, walletId: w.poolId });
    }
    expect(await seatChargedCents(w, w.marcusId)).toBe(100);
  });

  it('WAL-2 (partial) a seat stream\'s own budget is bounded by what is left of the allowance, not by the pool', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await seatCall(w, w.marcusId);
    await seatCall(w, w.marcusId);

    const gate = await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') });

    // 50¢ of 100¢ spent: after this call's 25¢ reservation the stream may spend 25¢ more, never the pool's ~9,000.
    expect(gate).toMatchObject({ allowed: true, walletId: w.poolId, balanceSnapshot: { netSpendableCents: 25 } });
  });

  /** Gate one seat call at the 25¢ estimate, then settle it at `costDollars` — its REAL cost. */
  async function seatCallCosting(w: World, userId: string, costDollars: number) {
    const gate = await canConsumeAI(userId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') });
    expect(gate).toMatchObject({ allowed: true, walletId: w.poolId });
    const [log] = await db.insert(aiUsageLogs).values({ userId, provider: 'openrouter', model: 'm', cost: costDollars }).returning({ id: aiUsageLogs.id });
    expect(await consumeCredits({ aiUsageLogId: log.id, userId, costDollars, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');
    return log.id;
  }

  /** What the gate counts against `userId`'s seat right now: the same read, the same period. */
  async function seatCounted(w: World, userId: string) {
    const pool = await walletRow(w.poolId);
    return loadSeatCapFacts(db, { poolId: w.poolId, poolPeriodStart: pool.monthlyPeriodStart, userId, policySeatAllowanceCents: null, now: new Date() });
  }

  it('WAL-2 (partial) WAL-6 (partial) a real charge that beats the estimate at the cap: the pool pays it, the member ends the period AT the cap, never over it', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    for (let call = 1; call <= 3; call += 1) await seatCallCosting(w, w.marcusId, COST_25C);

    // 75¢ of 100¢ spent. The fourth call is admitted on its 25¢ estimate and really costs 50¢.
    const logId = await seatCallCosting(w, w.marcusId, 2 * COST_25C);

    // The model ran, so the pool pays all 50¢ (WAL-6b/c): 75 + 50 = 125¢ out of the pool.
    const pool = await walletRow(w.poolId);
    expect(pool.monthlyRemainingCents).toBe(900_000 - 125);
    expect(pool.debtCents).toBe(0);
    // 25¢ of it went past Marcus's cap (125 − 100): recorded as the pool's absorbed overshoot.
    const overshoot = (await ledgerOf(w.marcusId)).filter((r) => r.entryType.startsWith('seat_overshoot'));
    expect(overshoot.map((r) => [r.entryType, r.walletId, r.aiUsageLogId, r.chargeMillicents, r.amountCents])).toEqual([['seat_overshoot_month', w.poolId, logId, 25_000, 0]]);
    // So the seat reads exactly its cap, not 125¢ ...
    expect((await seatCounted(w, w.marcusId)).usage.periodChargedMillicents).toBe(100_000);
    // ... the next call is refused by the cap and charges nothing, and his own credits are untouched.
    expect(await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') })).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
    expect((await walletRow(w.marcusWalletId)).monthlyRemainingCents).toBe(5_000);
  });

  it('WAL-2 (partial) WAL-7 (partial) a real charge that beats the estimate past a DAILY cap ends the day at the daily cap', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, dailyCapCents: 50, monthlyCapCents: 100 });
    await seatCallCosting(w, w.marcusId, COST_25C);

    // 25¢ of today's 50¢ spent; admitted on 25¢, really 50¢: today reaches 75¢, 25¢ past the daily cap.
    await seatCallCosting(w, w.marcusId, 2 * COST_25C);

    const counted = await seatCounted(w, w.marcusId);
    expect(counted.usage.dayChargedMillicents).toBe(50_000);
    // The DAY's overshoot never forgives the month: 25 + 50 = 75¢ gross, under the 100¢ monthly cap.
    expect(counted.usage.periodChargedMillicents).toBe(75_000);
    expect((await ledgerOf(w.marcusId)).filter((r) => r.entryType.startsWith('seat_overshoot')).map((r) => [r.entryType, r.chargeMillicents])).toEqual([['seat_overshoot_day', 25_000]]);
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(900_000 - 75);
    expect(await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') })).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
  });

  it('WAL-2 (partial) a cost-reconcile undercharge at the cap is capped like a settle: the pool pays it, the seat still reads its cap', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    const gen = `gen-seat-past-cap-${createId()}`;
    await seatCall(w, w.marcusId, gen);
    for (let call = 2; call <= 4; call += 1) await seatCall(w, w.marcusId);

    // At the cap (4 × 25¢ = 100¢). The first call really cost twice as much. The reconciler works in
    // whole real-cost cents: billed round(16.66667) = 17¢, actual round(33.33334) = 33¢, delta 16¢,
    // charged at 1.5× = 24¢ — taking the seat to 124¢, 24¢ past its cap.
    await reconcileOpenRouterCosts({ fetcher: async (id) => (id === gen ? { totalCost: 2 * COST_25C } : 'not_found') });

    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(900_000 - 124);
    expect((await ledgerOf(w.marcusId)).filter((r) => r.entryType.startsWith('seat_overshoot')).map((r) => [r.entryType, r.chargeMillicents])).toEqual([['seat_overshoot_month', 24_000]]);
    expect((await seatCounted(w, w.marcusId)).usage.periodChargedMillicents).toBe(100_000);
  });

  /** Move every seat row Marcus has on the pool one UTC day into the past: "the next day". */
  async function nextDay(w: World, userId: string) {
    await db.update(creditLedger).set({ createdAt: sql`${creditLedger.createdAt} - interval '1 day'` }).where(and(eq(creditLedger.userId, userId), eq(creditLedger.walletId, w.poolId)));
  }
  const seatGate = (w: World, userId: string) => canConsumeAI(userId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') });
  const overshootRows = async (userId: string) => (await ledgerOf(userId)).filter((r) => r.entryType.startsWith('seat_overshoot')).map((r) => [r.entryType, r.chargeMillicents]);

  it('WAL-2 (partial) WAL-7 (partial) IRV-A7: a DAILY overshoot never forgives the MONTH — the next day admits only what the monthly cap has left', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, dailyCapCents: 50, monthlyCapCents: 100 });
    // Day 1: 25¢, then a 25¢-estimate call that really costs 50¢ — 75¢ gross.
    await seatCallCosting(w, w.marcusId, COST_25C);
    await seatCallCosting(w, w.marcusId, 2 * COST_25C);
    expect((await seatCounted(w, w.marcusId)).usage.periodChargedMillicents).toBe(75_000);
    await nextDay(w, w.marcusId);

    // Day 2: 25¢ of the month is left, so ONE 25¢ call passes and the next is refused.
    await seatCallCosting(w, w.marcusId, COST_25C);
    expect(await seatGate(w, w.marcusId)).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });

    // 100¢ gross against the 100¢ monthly cap — not the 125¢ the shared forgiveness allowed.
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(900_000 - 100);
    expect((await seatCounted(w, w.marcusId)).usage.periodChargedMillicents).toBe(100_000);
  });

  it('WAL-2 (partial) WAL-7 (partial) a MONTHLY overshoot never forgives the DAY', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, dailyCapCents: 80, monthlyCapCents: 100 });
    for (let call = 1; call <= 3; call += 1) await seatCallCosting(w, w.marcusId, COST_25C);
    await nextDay(w, w.marcusId);

    // Today: a 25¢-estimate call that really costs 50¢ — the month reaches 125¢ (25¢ past), today only 50¢ of 80¢.
    await seatCallCosting(w, w.marcusId, 2 * COST_25C);

    const counted = await seatCounted(w, w.marcusId);
    expect(counted.usage.periodChargedMillicents).toBe(100_000);
    expect(counted.usage.dayChargedMillicents).toBe(50_000);
    expect(await overshootRows(w.marcusId)).toEqual([['seat_overshoot_month', 25_000]]);
  });

  it('WAL-2 (partial) WAL-7 (partial) one call past BOTH caps is forgiven once in each window, never twice in either', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, dailyCapCents: 50, monthlyCapCents: 100 });
    await seatCallCosting(w, w.marcusId, COST_25C);
    await seatCallCosting(w, w.marcusId, COST_25C);
    await nextDay(w, w.marcusId);
    await seatCallCosting(w, w.marcusId, COST_25C);

    // Month 75¢, today 25¢. A 25¢-estimate call that really costs 50¢: month 125¢, today 75¢ — 25¢ past each.
    await seatCallCosting(w, w.marcusId, 2 * COST_25C);

    const counted = await seatCounted(w, w.marcusId);
    expect(counted.usage.periodChargedMillicents).toBe(100_000);
    expect(counted.usage.dayChargedMillicents).toBe(50_000);
    expect((await overshootRows(w.marcusId)).sort()).toEqual([['seat_overshoot_day', 25_000], ['seat_overshoot_month', 25_000]]);
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(900_000 - 125);
  });

  it('WAL-2 (partial) WAL-7 (partial) a month of daily overshoots leaves the member at the monthly cap, never past it', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.update(wallets).set({ monthlyPeriodStart: new Date(Date.now() - 40 * 86_400_000) }).where(eq(wallets.id, w.poolId));
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, dailyCapCents: 50, monthlyCapCents: 100 });

    // Every day: a 25¢ call, then a 25¢-estimate call that really costs 50¢ — each only when the gate admits it.
    for (let day = 1; day <= 30; day += 1) {
      for (const cost of [COST_25C, 2 * COST_25C]) {
        if ((await seatGate(w, w.marcusId)).allowed === false) continue;
        await db.delete(creditHolds).where(eq(creditHolds.userId, w.marcusId));
        await seatCallCosting(w, w.marcusId, cost);
      }
      await nextDay(w, w.marcusId);
    }

    // Day 1: 25 + 50 = 75¢. Day 2: 25¢ left of the month — one 25¢ call. Then nothing, for 28 days.
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(900_000 - 100);
    expect((await seatCounted(w, w.marcusId)).usage.periodChargedMillicents).toBe(100_000);
    expect(await seatGate(w, w.marcusId)).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
  }, 30_000);

  it('WAL-2 (partial) IRV-A4: a reconcile refund on a call that overshot gives the forgiveness back — the seat is not re-opened past the cap', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    const gen = `gen-seat-refund-past-cap-${createId()}`;
    for (let call = 1; call <= 3; call += 1) await seatCallCosting(w, w.marcusId, COST_25C);
    // The 4th: a 25¢-estimate call billed 50¢, waiting for the cost-reconcile cron.
    const gate = await seatGate(w, w.marcusId);
    const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 2 * COST_25C, timestamp: new Date(Date.now() - 10 * 60_000), reconcileStatus: 'pending', reconcileAttempts: 0, metadata: { generationIds: [gen] } }).returning({ id: aiUsageLogs.id });
    await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 2 * COST_25C, holdId: gate.holdId, walletId: gate.walletId });
    expect(await overshootRows(w.marcusId)).toEqual([['seat_overshoot_month', 25_000]]);

    // It really cost 7¢: billed round(33.33334) = 33¢ real, delta 26¢ real × 1.5 = a 39¢ refund. Gross 125 − 39 = 86¢.
    await reconcileOpenRouterCosts({ fetcher: async (id) => (id === gen ? { totalCost: 0.07 } : 'not_found') });

    // Under the cap again, so nothing stays absorbed: the 25¢ forgiveness is given back and the seat reads the true 86¢.
    // Both rows carry the call's own time, so their order is not fixed: compare as a set.
    expect((await overshootRows(w.marcusId)).map(([, mc]) => mc).sort((x, y) => Number(y) - Number(x))).toEqual([25_000, -25_000]);
    expect((await overshootRows(w.marcusId)).every(([t]) => t === 'seat_overshoot_month')).toBe(true);
    expect((await seatCounted(w, w.marcusId)).usage.periodChargedMillicents).toBe(86_000);
    // 14¢ left: a 25¢ reservation does not fit.
    expect(await seatGate(w, w.marcusId)).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
  });

  /** A seat call gated at its 25¢ estimate and billed at `costDollars`, waiting for the cost-reconcile cron under `generationId`. */
  async function reconcilableSeatCall(w: World, userId: string, costDollars: number, generationId: string) {
    const gate = await seatGate(w, userId);
    expect(gate).toMatchObject({ allowed: true, walletId: w.poolId });
    const [log] = await db.insert(aiUsageLogs).values({ userId, provider: 'openrouter', model: 'm', cost: costDollars, timestamp: new Date(Date.now() - 10 * 60_000), reconcileStatus: 'pending', reconcileAttempts: 0, metadata: { generationIds: [generationId] } }).returning({ id: aiUsageLogs.id });
    expect(await consumeCredits({ aiUsageLogId: log.id, userId, costDollars, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');
    return log.id;
  }
  /** Gate-and-settle 25¢ seat calls until the gate refuses (at most `max`); returns how many passed. */
  async function spendUntilRefused(w: World, userId: string, max = 10): Promise<number> {
    let passed = 0;
    while (passed < max && (await seatGate(w, userId)).allowed) {
      await db.delete(creditHolds).where(eq(creditHolds.userId, userId));
      await seatCallCosting(w, userId, COST_25C);
      passed += 1;
    }
    return passed;
  }
  const utcToday = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

  it('WAL-2 (partial) WAL-7 (partial) IRV-C1: a reconcile refund for YESTERDAY\'s call counts in yesterday, never opening room past today\'s daily cap', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, dailyCapCents: 50, monthlyCapCents: 1_000 });
    const gen = `gen-c1-${createId()}`;
    // Yesterday: a 25¢-estimate call billed 75¢ — 25¢ past yesterday's 50¢ daily cap.
    await reconcilableSeatCall(w, w.marcusId, 3 * COST_25C, gen);
    await nextDay(w, w.marcusId);

    // Today the cron reconciles it down: billed real cost round(3 × 16.66667 = 50.00001) = 50¢, actually 7¢: 43¢ real × 1.5 = 64_500 mc
    // back (the pool is credited round(64.5) = 65¢). Yesterday nets 75_000 − 64_500 = 10_500 mc, under its 50¢ cap.
    await reconcileOpenRouterCosts({ fetcher: async (id) => (id === gen ? { totalCost: 0.07 } : 'not_found') });

    // Today still has exactly its own 50¢: two 25¢ calls, then refused — not three.
    expect(await spendUntilRefused(w, w.marcusId)).toBe(2);
    expect((await seatCounted(w, w.marcusId)).usage.dayChargedMillicents).toBe(50_000);
    // The refund gave yesterday's forgiveness back IN yesterday: every day-overshoot row is dated before today.
    const dayRows = (await ledgerOf(w.marcusId)).filter((r) => r.entryType === 'seat_overshoot_day');
    expect(dayRows.map((r) => Number(r.chargeMillicents)).sort((x, y) => y - x)).toEqual([25_000, -25_000]);
    expect(dayRows.every((r) => r.createdAt.getTime() < utcToday())).toBe(true);
  });

  it('WAL-2 (partial) IRV-C2: a reconcile refund for a call from the CLOSED period never opens room in the new period', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    const gen = `gen-c2-${createId()}`;
    // Last period: a call billed 50¢. Then the pool refills.
    await reconcilableSeatCall(w, w.marcusId, 2 * COST_25C, gen);
    await db.update(creditLedger).set({ createdAt: new Date(Date.now() - 3_600_000) }).where(and(eq(creditLedger.userId, w.marcusId), eq(creditLedger.walletId, w.poolId)));
    await db.update(wallets).set({ monthlyPeriodStart: new Date(Date.now() - 60_000) }).where(eq(wallets.id, w.poolId));

    // After the refill the cron refunds it: billed 33¢ real, actually 7¢, 26¢ × 1.5 = 39¢ back to the pool.
    await reconcileOpenRouterCosts({ fetcher: async (id) => (id === gen ? { totalCost: 0.07 } : 'not_found') });

    // The new period has exactly its own 100¢: four 25¢ calls, then refused — not five.
    const before = (await walletRow(w.poolId)).monthlyRemainingCents;
    expect(await spendUntilRefused(w, w.marcusId)).toBe(4);
    expect(before - (await walletRow(w.poolId)).monthlyRemainingCents).toBe(100);
    expect((await ledgerOf(w.marcusId)).filter((r) => r.entryType.startsWith('seat_overshoot'))).toEqual([]);
  });

  it('WAL-2 (partial) an UNDERCHARGE reconciled after the refill for a call from the closed period is not billed against the new period', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    const gen = `gen-c2-under-${createId()}`;
    // Last period: a call billed 25¢. Then the pool refills.
    await reconcilableSeatCall(w, w.marcusId, COST_25C, gen);
    await db.update(creditLedger).set({ createdAt: new Date(Date.now() - 3_600_000) }).where(and(eq(creditLedger.userId, w.marcusId), eq(creditLedger.walletId, w.poolId)));
    await db.update(wallets).set({ monthlyPeriodStart: new Date(Date.now() - 60_000) }).where(eq(wallets.id, w.poolId));

    // After the refill it reconciles UP: billed 17¢ real, actually 33¢ (2 × 16.66667), 16¢ × 1.5 = 24¢ more. The pool pays it,
    // but it belongs to last period's call: the new period still has its whole 100¢ — four 25¢ calls.
    await reconcileOpenRouterCosts({ fetcher: async (id) => (id === gen ? { totalCost: 2 * COST_25C } : 'not_found') });
    expect((await seatCounted(w, w.marcusId)).usage.periodChargedMillicents).toBe(0);
    expect(await spendUntilRefused(w, w.marcusId)).toBe(4);
  });

  it('WAL-2 (partial) WAL-7 (partial) IRV-M1: an UNDERCHARGE reconciled today for a call made before BOTH windows (2 days ago, pool refilled since) counts in neither', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, dailyCapCents: 50, monthlyCapCents: 100 });
    const gen = `gen-irv-m1-${createId()}`;
    // A 25¢ seat call two UTC days ago — before today's midnight — and the pool refilled an hour ago, so the call
    // sits before BOTH windows (and before the rows the read reaches back to: min(period start, UTC midnight)).
    await reconcilableSeatCall(w, w.marcusId, COST_25C, gen);
    await nextDay(w, w.marcusId);
    await nextDay(w, w.marcusId);
    await refillAt(w, new Date(Date.now() - 3_600_000));

    // Today the cron reconciles it UP: billed round(16.66667) = 17¢ real, actually round(66.66668) = 67¢ — 50¢ real
    // × 1.5 = 75¢ (75_000 mc) more. The pool pays it, but it belongs to the two-day-old call, not to this period or today.
    await reconcileOpenRouterCosts({ fetcher: async (id) => (id === gen ? { totalCost: 4 * COST_25C } : 'not_found') });

    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(900_000 - 25 - 75);
    const counted = await seatCounted(w, w.marcusId);
    expect(counted.usage.periodChargedMillicents).toBe(0);
    expect(counted.usage.dayChargedMillicents).toBe(0);
    // Today keeps its whole 50¢ daily cap: exactly two 25¢ calls, then refused.
    expect(await spendUntilRefused(w, w.marcusId)).toBe(2);
  });

  it('WAL-2 (partial) WAL-7 (partial) an admin RAISING the DAILY cap takes effect at once on today\'s gross', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, dailyCapCents: 50, monthlyCapCents: 1_000 });
    await seatCallCosting(w, w.marcusId, COST_25C);
    await seatCallCosting(w, w.marcusId, 2 * COST_25C);
    // Today: 75¢ gross against 50¢ — 25¢ absorbed, the day reads 50¢.
    expect((await seatCounted(w, w.marcusId)).usage.dayChargedMillicents).toBe(50_000);

    await db.update(walletConsumerCaps).set({ dailyCapCents: 100 }).where(eq(walletConsumerCaps.walletId, w.poolId));

    // The day is the real 75¢ against the new 100¢: exactly one more 25¢ call, not two.
    expect((await seatCounted(w, w.marcusId)).usage.dayChargedMillicents).toBe(75_000);
    expect(await spendUntilRefused(w, w.marcusId)).toBe(1);
  });

  it('WAL-2 (partial) IRV-C3: an admin RAISING the cap takes effect at once on gross — concurrent calls fit only what the new cap leaves', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, monthlyCapCents: 100 });
    for (let call = 1; call <= 3; call += 1) await seatCallCosting(w, w.marcusId, COST_25C);
    await seatCallCosting(w, w.marcusId, 2 * COST_25C);
    // 125¢ gross against 100¢: 25¢ absorbed, the seat reads 100¢.
    expect((await seatCounted(w, w.marcusId)).usage.periodChargedMillicents).toBe(100_000);

    await db.update(walletConsumerCaps).set({ monthlyCapCents: 150 }).where(eq(walletConsumerCaps.walletId, w.poolId));

    // The count is the real 125¢ against the new 150¢: 25¢ left, so of two simultaneous 25¢ calls exactly one passes.
    expect((await seatCounted(w, w.marcusId)).usage.periodChargedMillicents).toBe(125_000);
    const gates = await withSlowHoldInserts(w.marcusId, () => Promise.all([seatGate(w, w.marcusId), seatGate(w, w.marcusId)]));
    expect(gates.filter((g) => g.allowed)).toHaveLength(1);
    expect(gates.find((g) => !g.allowed)).toMatchObject({ refusal: { reason: 'source_cap_reached' } });
    // And its stream may spend nothing past the reservation: 150 − 125 − 25 = 0.
    expect(gates.find((g) => g.allowed)).toMatchObject({ balanceSnapshot: { netSpendableCents: 0 } });
  });

  it('WAL-2 (partial) a cap LOWERED below what is already spent leaves no room — never negative — until the pool refills', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, monthlyCapCents: 100 });
    for (let call = 1; call <= 3; call += 1) await seatCallCosting(w, w.marcusId, COST_25C);

    await db.update(walletConsumerCaps).set({ monthlyCapCents: 50 }).where(eq(walletConsumerCaps.walletId, w.poolId));

    // 75¢ spent against 50¢: the seat reads full (50¢), not 75¢ and not negative room; refused.
    expect((await seatCounted(w, w.marcusId)).usage.periodChargedMillicents).toBe(50_000);
    expect(await seatGate(w, w.marcusId)).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
    // Not forever: the next refill starts a period with the new cap whole — two 25¢ calls.
    await db.update(creditLedger).set({ createdAt: new Date(Date.now() - 3_600_000) }).where(and(eq(creditLedger.userId, w.marcusId), eq(creditLedger.walletId, w.poolId)));
    await db.update(wallets).set({ monthlyPeriodStart: new Date(Date.now() - 60_000) }).where(eq(wallets.id, w.poolId));
    expect(await spendUntilRefused(w, w.marcusId)).toBe(2);
  });

  it('WAL-2 (partial) a correction larger than its call nets that call to zero — it never manufactures room for other calls', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    const logId = await seatCallCosting(w, w.marcusId, COST_25C);
    // A correction row of −60¢ against that 25¢ call (a malformed or double refund).
    await db.insert(creditLedger).values({ userId: w.marcusId, walletId: w.poolId, entryType: 'adjustment', bucket: 'monthly', amountCents: 60, chargeMillicents: -60_000, aiUsageLogId: logId, consumeStatus: 'applied', appliedCents: 0 });

    // That call counts 0, not −35¢: the 100¢ allowance holds exactly four more 25¢ calls.
    expect((await seatCounted(w, w.marcusId)).usage.periodChargedMillicents).toBe(0);
    expect(await spendUntilRefused(w, w.marcusId)).toBe(4);
  });

  /** The pool refills at `at`: its period starts there (D-OW-12). */
  const refillAt = (w: World, at: Date) => db.update(wallets).set({ monthlyPeriodStart: at }).where(eq(wallets.id, w.poolId));
  /** Keep the test's "earlier today" inside today: not in the first seconds after UTC midnight. */
  const clearOfMidnight = async () => { if (Date.now() - utcToday() < 10_000) await new Promise((r) => setTimeout(r, 10_000)); };

  it('WAL-7 (partial) WAL-2 (partial) IRV-R7: a pool refill MID-DAY restarts the month, not the day — no second daily allowance', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, dailyCapCents: 50, monthlyCapCents: 1_000 });
    await clearOfMidnight();
    // Earlier today: the whole 50¢ daily cap.
    await seatCallCosting(w, w.marcusId, COST_25C);
    await seatCallCosting(w, w.marcusId, COST_25C);
    await db.update(creditLedger).set({ createdAt: new Date(Date.now() - 5_000) }).where(and(eq(creditLedger.userId, w.marcusId), eq(creditLedger.walletId, w.poolId)));

    // The pool refills later the same UTC day.
    await refillAt(w, new Date(Date.now() - 2_000));

    // The new period is empty, but today is still spent: refused by the DAILY cap, not a fresh 50¢.
    const counted = await seatCounted(w, w.marcusId);
    expect(counted.usage.periodChargedMillicents).toBe(0);
    expect(counted.usage.dayChargedMillicents).toBe(50_000);
    expect(await seatGate(w, w.marcusId)).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
  });

  it('WAL-7 (partial) WAL-2 (partial) a refill exactly AT UTC midnight: yesterday counts in neither window, today in both', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, dailyCapCents: 50, monthlyCapCents: 100 });
    // Yesterday: 50¢, the whole daily cap. The pool then refills exactly at today's UTC midnight.
    await seatCallCosting(w, w.marcusId, COST_25C);
    await seatCallCosting(w, w.marcusId, COST_25C);
    await nextDay(w, w.marcusId);
    await refillAt(w, new Date(utcToday()));

    // Today: the daily 50¢ — two calls — and the month holds only today's spend.
    expect(await spendUntilRefused(w, w.marcusId)).toBe(2);
    const counted = await seatCounted(w, w.marcusId);
    expect(counted.usage.dayChargedMillicents).toBe(50_000);
    expect(counted.usage.periodChargedMillicents).toBe(50_000);
  });

  it('WAL-7 (partial) WAL-2 (partial) a call gated before a mid-day refill and settled after it counts in the NEW period and in today', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, dailyCapCents: 100, monthlyCapCents: 100 });
    await clearOfMidnight();
    // Call A settles before the refill; call B is admitted before it and settles after.
    await seatCallCosting(w, w.marcusId, COST_25C);
    const gateB = await seatGate(w, w.marcusId);
    expect(gateB).toMatchObject({ allowed: true, walletId: w.poolId });
    await db.update(creditLedger).set({ createdAt: new Date(Date.now() - 5_000) }).where(and(eq(creditLedger.userId, w.marcusId), eq(creditLedger.walletId, w.poolId)));
    await refillAt(w, new Date(Date.now() - 2_000));
    const [logB] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: COST_25C }).returning({ id: aiUsageLogs.id });
    expect(await consumeCredits({ aiUsageLogId: logB.id, userId: w.marcusId, costDollars: COST_25C, holdId: gateB.holdId, walletId: gateB.walletId })).toBe('settled');

    // The period holds B only (its charge entered the ledger after the refill); today holds A and B.
    const counted = await seatCounted(w, w.marcusId);
    expect(counted.usage.periodChargedMillicents).toBe(25_000);
    expect(counted.usage.dayChargedMillicents).toBe(50_000);
    // Today has 50¢ left of its 100¢, the month 75¢: the day binds — two more calls.
    expect(await spendUntilRefused(w, w.marcusId)).toBe(2);
  });

  it('WAL-2 (partial) WAL-7 (partial) a seat stream\'s own budget is bounded by what is left of the DAILY cap when it is the smaller', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, dailyCapCents: 60, monthlyCapCents: 100 });
    await seatCall(w, w.marcusId);

    const gate = await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') });

    // 25¢ spent: 35¢ left today, 75¢ this month. After the 25¢ reservation the stream may spend 35 − 25 = 10¢, not 75 − 25 = 50¢.
    expect(gate).toMatchObject({ allowed: true, walletId: w.poolId, balanceSnapshot: { netSpendableCents: 10 } });
  });

  it('WAL-2 (partial) two members each get their own seat allowance on the same pool', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    const lenaId = await addLena(w);

    for (let call = 0; call < 4; call += 1) await seatCall(w, w.marcusId);
    const marcusCapped = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'seat_allowance') });
    expect(marcusCapped).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });

    // Marcus's spent cap is his alone: Lena's allowance is whole.
    for (let call = 1; call <= 4; call += 1) {
      expect(await seatCall(w, lenaId), `Lena call ${call}`).toMatchObject({ allowed: true, walletId: w.poolId });
    }
    const lenaCapped = await canConsumeAI(lenaId, 'free', { spend: driveSpend(w.productId, 'seat_allowance') });
    expect(lenaCapped).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });

    expect(await seatChargedCents(w, w.marcusId)).toBe(100);
    expect(await seatChargedCents(w, lenaId)).toBe(100);
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(900_000 - 200);
  });

  it('WAL-2 (partial) D-OW-12 the seat allowance resets on the POOL refill date, not on the member\'s personal renewal', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    for (let call = 0; call < 4; call += 1) await seatCall(w, w.marcusId);
    expect(await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'seat_allowance') })).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });

    // Marcus's own plan renews now: his personal period moves, and his seat stays spent.
    await db.update(wallets).set({ monthlyPeriodStart: new Date(), monthlyPeriodEnd: new Date(Date.now() + 30 * 86_400_000) }).where(eq(wallets.id, w.marcusWalletId));
    expect(await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'seat_allowance') })).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });

    // The org's invoice is paid for a period starting now: the pool refills and its clock moves.
    const [org] = await db.select().from(organizations).where(eq(organizations.id, w.orgId));
    const startS = Math.floor(Date.now() / 1000) + 1;
    const refill = await applyOrgPoolRefill({
      id: `in_${createId()}`,
      customer: org.stripeCustomerId,
      billing_reason: 'subscription_cycle',
      amount_paid: 5000,
      subtotal: 5000,
      parent: { subscription_details: { subscription: `sub_${createId()}` } },
      lines: { data: [{ amount: 5000, parent: { subscription_item_details: { subscription_item: 'si_org' } }, period: { start: startS, end: startS + 30 * 86_400 }, pricing: { price_details: { price: REFILL_PRICE_ID } } }] },
    }, { active: true, basePriceId: REFILL_PRICE_ID, seatPriceId: REFILL_SEAT_PRICE_ID });
    expect(refill).toMatchObject({ kind: 'granted', walletId: w.poolId });
    expect((await walletRow(w.poolId)).monthlyPeriodStart?.getTime()).toBe(startS * 1000);
    // Wait out the one second to the new period's start, so the refill is in force.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, startS * 1000 - Date.now() + 5)));

    expect(await seatCall(w, w.marcusId)).toMatchObject({ allowed: true, walletId: w.poolId, spendSource: 'seat_allowance' });
  });

  it('WAL-2 (partial) a seat allowance of zero refuses by the cap and charges nothing, even with a full pool', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, monthlyCapCents: 0 });

    const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'seat_allowance') });

    expect(gate).toEqual({
      allowed: false,
      reason: 'source_refused',
      refusal: { source: 'seat_allowance', reason: 'source_cap_reached', options: ['drive_wallet', 'own_credits'] },
    });
    expect(await holdsOf(w.marcusId)).toEqual([]);
    expect(await ledgerOf(w.marcusId)).toEqual([]);
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(900_000);
    expect((await walletRow(w.marcusWalletId)).monthlyRemainingCents).toBe(5_000);
    // A per-consumer cap governs that consumer only.
    expect(await seatCall(w, await addLena(w))).toMatchObject({ allowed: true, walletId: w.poolId });
  });

  it('WAL-2 (partial) a per-consumer cap on the pool leg is that member\'s allowance, above or below the default', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, monthlyCapCents: 50 });

    expect(await seatCall(w, w.marcusId)).toMatchObject({ allowed: true });
    expect(await seatCall(w, w.marcusId)).toMatchObject({ allowed: true });
    expect(await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'seat_allowance') })).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
    expect(await seatChargedCents(w, w.marcusId)).toBe(50);
  });

  it('WAL-2 (partial) cost-reconcile corrections count against the allowance in BOTH directions: a refund gives room back, an undercharge takes it', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    const gen = { refunded: `gen-seat-refund-${createId()}`, undercharged: `gen-seat-under-${createId()}` };
    await seatCall(w, w.marcusId, gen.refunded);
    await seatCall(w, w.marcusId, gen.undercharged);
    await seatCall(w, w.marcusId);
    await seatCall(w, w.marcusId);
    const capped = () => canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') });
    expect(await capped()).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });

    // The first call really cost nothing: its 25¢ comes back to the pool and to Marcus's allowance.
    await reconcileOpenRouterCosts({ fetcher: async (id) => (id === gen.refunded ? { totalCost: 0 } : 'not_found') });
    const roomAgain = await capped();
    expect(roomAgain).toMatchObject({ allowed: true, walletId: w.poolId });
    await db.delete(creditHolds).where(eq(creditHolds.id, roomAgain.holdId ?? ''));

    // The second really cost twice as much: the extra 25¢ is taken from the allowance again.
    await reconcileOpenRouterCosts({ fetcher: async (id) => (id === gen.undercharged ? { totalCost: 2 * COST_25C } : 'not_found') });
    expect(await capped()).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
    // The pool moved by exactly what the ledger says Marcus took from it, corrections included.
    const pool = await walletRow(w.poolId);
    const taken = (await db.select().from(creditLedger).where(and(eq(creditLedger.walletId, w.poolId), eq(creditLedger.userId, w.marcusId))))
      .reduce((sum, r) => sum - (r.appliedCents ?? 0), 0);
    expect(pool.monthlyRemainingCents + pool.topupRemainingCents - pool.debtCents).toBe(900_000 - taken);
  });

  it('WAL-2 (partial) WAL-7 (partial) a daily cap set on a member\'s seat binds per UTC day inside the monthly allowance', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, dailyCapCents: 50, monthlyCapCents: 100 });

    expect(await seatCall(w, w.marcusId)).toMatchObject({ allowed: true });
    expect(await seatCall(w, w.marcusId)).toMatchObject({ allowed: true });
    const third = await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') });
    expect(third).toEqual({ allowed: false, reason: 'source_refused', refusal: { source: 'seat_allowance', reason: 'source_cap_reached', options: ['drive_wallet', 'own_credits'] } });

    // Yesterday's 50¢ no longer counts against today, but still counts against the month.
    await db.update(creditLedger).set({ createdAt: new Date(Date.now() - 36 * 3_600_000) }).where(and(eq(creditLedger.userId, w.marcusId), eq(creditLedger.walletId, w.poolId)));
    expect(await seatCall(w, w.marcusId)).toMatchObject({ allowed: true });
    expect(await seatCall(w, w.marcusId)).toMatchObject({ allowed: true });
    expect(await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') })).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
    expect(await seatChargedCents(w, w.marcusId)).toBe(100);
  });

  it('WAL-2 (partial) the funding-legs invariant holds after capped seat spends beside drive-wallet spends on donated legs', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 0, poolCents: 900_000 });
    const w = world;
    // Product has no allocation: its only money is Marcus's donation leg.
    expect(await donateToDriveWallet({ donorUserId: w.marcusId, targetWalletId: w.productWalletId, amountCents: 200, donationId: createId() })).toMatchObject({ kind: 'donated' });

    for (let call = 0; call < 5; call += 1) await seatCall(w, w.marcusId);
    const drive = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet') });
    expect(drive).toMatchObject({ allowed: true, walletId: w.productWalletId });
    const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: COST_25C }).returning({ id: aiUsageLogs.id });
    await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: COST_25C, holdId: drive.holdId, walletId: drive.walletId });

    expect(await seatChargedCents(w, w.marcusId)).toBe(100);
    expect((await walletRow(w.productWalletId)).topupRemainingCents).toBe(175);
    await expectWalletLegInvariant([w.productWalletId]);
  });

  // ---------------------------------------------------------------------------
  // SPEND-4: a fallback is never silent. On a personal drive the lead may set the drive's
  // fallback rule; when it moves a call, the gate's answer says from which source to which.
  // ---------------------------------------------------------------------------

  /** Jono's personal drive "Side Project", its wallet under Jono's root, Marcus a member; the rule set by Jono. */
  async function personalDrive(w: World, input: { allocationCents: number; fallbackRule: 'refuse' | 'own_credits' | null }) {
    const [jonoRoot] = await db.insert(wallets).values({ userId: w.jonoId, monthlyRemainingCents: 9_000, monthlyPeriodStart: new Date(), monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000) }).returning();
    const side = await factories.createDrive(w.jonoId, { name: 'Side Project', slug: `side-${createId()}` });
    await factories.createDriveMember(side.id, w.marcusId, { source: 'invite' });
    const [sideWallet] = await db.insert(wallets).values({
      userId: w.jonoId, subjectType: 'drive', subjectId: side.id, parentWalletId: jonoRoot.id,
      monthlyAllowanceCents: input.allocationCents, fallbackRule: input.fallbackRule,
    }).returning();
    return { driveId: side.id, walletId: sideWallet.id, jonoRootId: jonoRoot.id };
  }

  async function teardownPersonalDrive(side: { driveId: string; walletId: string }): Promise<void> {
    await db.delete(creditHolds).where(eq(creditHolds.walletId, side.walletId));
    await db.delete(wallets).where(eq(wallets.id, side.walletId));
    await db.delete(drives).where(eq(drives.id, side.driveId));
  }

  it('SPEND-4 (partial) with several sources and none chosen, a default the person set that cannot be spent here refuses rather than picking one', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    // Jono's personal drive has a wallet and Marcus his own credits there, but no seat: the default he saved.
    const side = await personalDrive(world, { allocationCents: 1_000, fallbackRule: null });
    await db.update(wallets).set({ defaultSpendSource: 'seat_allowance' }).where(eq(wallets.id, world.marcusWalletId));
    try {
      const gate = await canConsumeAI(world.marcusId, 'free', { spend: driveSpend(side.driveId, null) });

      expect(gate).toMatchObject({ allowed: false, reason: 'source_refused', refusal: { source: null, reason: 'no_source_chosen' } });
      expect(await holdsOf(world.marcusId)).toEqual([]);
    } finally {
      await teardownPersonalDrive(side);
    }
  });

  it('SPEND-4 (partial) a drive-rule fallback is reported with the source it moved FROM and TO, and holds on the source it moved to', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    const side = await personalDrive(w, { allocationCents: 0, fallbackRule: 'own_credits' });
    const info = vi.spyOn(loggers.ai, 'info');
    try {
      const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(side.driveId, 'drive_wallet') });

      expect(gate).toMatchObject({ allowed: true, walletId: w.marcusWalletId, spendSource: 'own_credits' });
      expect(gate.fallback).toEqual({ from: 'drive_wallet', to: 'own_credits' });
      expect((await holdsOf(w.marcusId)).map((h) => h.walletId)).toEqual([w.marcusWalletId]);
      // The switch is recorded too, never only implied by the wallet id.
      expect(info).toHaveBeenCalledWith('spend source fell back', expect.objectContaining({
        userId: w.marcusId, driveId: side.driveId, from: 'drive_wallet', to: 'own_credits',
      }));
    } finally {
      await teardownPersonalDrive(side);
    }
  });

  it('SPEND-4 (partial) a call that spends its chosen source carries no fallback', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    const side = await personalDrive(w, { allocationCents: 1_000, fallbackRule: 'own_credits' });
    try {
      const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(side.driveId, 'drive_wallet') });

      expect(gate).toMatchObject({ allowed: true, walletId: side.walletId, spendSource: 'drive_wallet' });
      expect(gate.fallback).toBeUndefined();
    } finally {
      await teardownPersonalDrive(side);
    }
  });

  it('SPEND-4 (partial) with the rule at refuse the same empty source is refused by name and charges nothing — no fallback', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    const side = await personalDrive(w, { allocationCents: 0, fallbackRule: 'refuse' });
    try {
      const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(side.driveId, 'drive_wallet') });

      expect(gate).toEqual({ allowed: false, reason: 'source_refused', refusal: { source: 'drive_wallet', reason: 'source_empty', options: ['own_credits'] } });
      await expectNothingCharged(w);
    } finally {
      await teardownPersonalDrive(side);
    }
  });

  // ---------------------------------------------------------------------------
  // SPEND-3 / SPEND-4: a conversation's source is chosen once and persists for it, and the gate
  // never moves it to another wallet without saying so.
  // ---------------------------------------------------------------------------

  const chosenWalletOf = async (conversationId: string) =>
    (await db.select({ id: conversations.chosenWalletId }).from(conversations).where(eq(conversations.id, conversationId)))[0]?.id ?? null;

  /** Gate Marcus's turn in `conversationId` of `driveId` and release the hold at once (nothing settles). */
  async function turn(w: World, driveId: string, conversationId: string) {
    const gate = await canConsumeAI(w.marcusId, 'free', { spend: conversationSpend(driveId, conversationId) });
    if (gate.allowed && gate.holdId) await releaseHold(gate.holdId);
    return gate;
  }

  it('SPEND-3 a conversation\'s source is chosen once and persists for it: the first call pins the drive\'s default over the person\'s; later default changes and an emptied wallet never move it; an explicit switch replaces it and persists; with no drive default the person\'s Settings default is pinned', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    await db.update(wallets).set({ defaultSpendSource: 'drive_wallet' }).where(eq(wallets.id, w.productWalletId));
    await db.update(wallets).set({ defaultSpendSource: 'own_credits' }).where(eq(wallets.id, w.marcusWalletId));
    const conv = await conversationIn(w.productId, w.marcusId, null);

    // First call: the drive's default before the person's, pinned on the conversation.
    expect(await turn(w, w.productId, conv)).toMatchObject({ allowed: true, walletId: w.productWalletId, spendSource: 'drive_wallet', conversationSourceWalletId: w.productWalletId });
    expect(await chosenWalletOf(conv)).toBe(w.productWalletId);

    // The lead and the person both change their defaults: the conversation keeps its source.
    await db.update(wallets).set({ defaultSpendSource: 'seat_allowance' }).where(inArray(wallets.id, [w.productWalletId, w.marcusWalletId]));
    expect(await turn(w, w.productId, conv)).toMatchObject({ allowed: true, walletId: w.productWalletId, spendSource: 'drive_wallet' });

    // The wallet empties: the conversation is still on it — refused by name, never re-preselected onto the seat.
    await db.update(wallets).set({ spentCents: 1_000 }).where(eq(wallets.id, w.productWalletId));
    expect(await turn(w, w.productId, conv)).toEqual({
      allowed: false, reason: 'source_refused', refusal: { source: 'drive_wallet', reason: 'source_empty', options: ['seat_allowance', 'own_credits'] },
    });
    expect(await chosenWalletOf(conv)).toBe(w.productWalletId);

    // An explicit switch replaces it, and persists across turns.
    expect(await setConversationSpend(w.marcusId, conv, w.marcusWalletId, 'session')).toMatchObject({ ok: true, chosenWalletId: w.marcusWalletId });
    for (let i = 0; i < 2; i++) {
      expect(await turn(w, w.productId, conv)).toMatchObject({ allowed: true, walletId: w.marcusWalletId, spendSource: 'own_credits' });
    }
    expect(await chosenWalletOf(conv)).toBe(w.marcusWalletId);

    // A new conversation in a drive with no default of its own: the person's Settings default is pinned.
    await db.update(wallets).set({ defaultSpendSource: null }).where(eq(wallets.id, w.productWalletId));
    await db.update(wallets).set({ defaultSpendSource: 'own_credits' }).where(eq(wallets.id, w.marcusWalletId));
    const next = await conversationIn(w.productId, w.marcusId, null);
    expect(await turn(w, w.productId, next)).toMatchObject({ allowed: true, walletId: w.marcusWalletId, spendSource: 'own_credits' });
    expect(await chosenWalletOf(next)).toBe(w.marcusWalletId);
    expect(await holdsOf(w.marcusId)).toEqual([]);
  });

  it('SPEND-3 (partial) a first turn gates before its conversation row exists: the gate returns the preselected wallet and its creator pins it once created; a pin never lands on another drive\'s or a global conversation, and never replaces a stored choice', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    const fresh = createId();

    const gate = await turn(w, w.productId, fresh);
    expect(gate).toMatchObject({ allowed: true, walletId: w.productWalletId, conversationSourceWalletId: w.productWalletId });
    await db.insert(conversations).values({ id: fresh, userId: w.marcusId, type: 'drive', contextId: w.productId, updatedAt: new Date() });
    await pinConversationSource({ userId: w.marcusId, conversationId: fresh, driveId: w.productId, walletId: gate.conversationSourceWalletId as string });
    expect(await chosenWalletOf(fresh)).toBe(w.productWalletId);

    // Never replaces what is stored.
    await pinConversationSource({ userId: w.marcusId, conversationId: fresh, driveId: w.productId, walletId: w.marcusWalletId });
    expect(await chosenWalletOf(fresh)).toBe(w.productWalletId);
    // Another drive's conversation, a global conversation, and someone else's conversation are never pinned.
    const elsewhere = await conversationIn(createId(), w.marcusId, null);
    const [global] = await db.insert(conversations).values({ userId: w.marcusId, type: 'global', updatedAt: new Date() }).returning({ id: conversations.id });
    const jonos = await conversationIn(w.productId, w.jonoId, null);
    for (const [conversationId, userId] of [[elsewhere, w.marcusId], [global.id, w.marcusId], [jonos, w.marcusId]] as const) {
      await pinConversationSource({ userId, conversationId, driveId: w.productId, walletId: w.productWalletId });
      expect(await chosenWalletOf(conversationId)).toBeNull();
    }
  });

  it('SPEND-4 the gate never picks a different wallet silently: a preselected drive wallet that empties refuses naming it with the remaining options and charges nothing; under the drive\'s fallback rule the call moves only with the move reported to the turn and to the chip\'s preview (from, to, the wallet held)', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    const side = await personalDrive(w, { allocationCents: 1_000, fallbackRule: 'refuse' });
    try {
      // Out of the box (nothing chosen, no default): the drive's wallet, pinned.
      const conv = await conversationIn(side.driveId, w.marcusId, null);
      expect(await turn(w, side.driveId, conv)).toMatchObject({ allowed: true, walletId: side.walletId, spendSource: 'drive_wallet' });
      expect((await turn(w, side.driveId, conv)).fallback).toBeUndefined();

      // Emptied: refused BY NAME with the remaining option, nothing held, nothing charged — never own credits.
      for (const emptied of [{ spentCents: 1_000 }, { spentCents: 0, status: 'paused' as const }]) {
        await db.update(wallets).set({ status: 'active', ...emptied }).where(eq(wallets.id, side.walletId));
        const refused = await turn(w, side.driveId, conv);
        expect(refused).toMatchObject({ allowed: false, reason: 'source_refused', refusal: { source: 'drive_wallet', options: ['own_credits'] } });
        await expectNothingCharged(w);
      }

      // The drive's rule allows a fallback: the call moves, and the move travels with the answer.
      await db.update(wallets).set({ status: 'active', spentCents: 1_000, fallbackRule: 'own_credits' }).where(eq(wallets.id, side.walletId));
      const moved = await canConsumeAI(w.marcusId, 'free', { spend: conversationSpend(side.driveId, conv) });
      expect(moved).toMatchObject({ allowed: true, walletId: w.marcusWalletId, spendSource: 'own_credits', fallback: { from: 'drive_wallet', to: 'own_credits' }, fallbackFromWalletId: side.walletId });
      expect((await holdsOf(w.marcusId)).map((h) => [h.walletId, h.fallbackFromWalletId])).toEqual([[w.marcusWalletId, side.walletId]]);
      if (moved.holdId) await releaseHold(moved.holdId);
      // The conversation's own source is unchanged; the chip's preview names the source it moved to, as a fallback.
      expect(await chosenWalletOf(conv)).toBe(side.walletId);
      const preview = await getConversationSpend(w.marcusId, conv);
      expect(preview).toMatchObject({ ok: true, chosenWalletId: side.walletId, resolved: { kind: 'spend', source: 'own_credits', walletId: w.marcusWalletId, fallbackApplied: true, fallbackFrom: 'drive_wallet' } });
    } finally {
      await db.delete(conversations).where(eq(conversations.userId, w.marcusId));
      await teardownPersonalDrive(side);
    }
  });

  it('WAL-6 (partial) a fallback onto own credits records the chosen wallet on the hold, and its overshoot lands where that choice would have put it — never on the consumer', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    const side = await personalDrive(w, { allocationCents: 0, fallbackRule: 'own_credits' });
    // Marcus's own credits cover the reservation but not the real cost.
    await db.update(wallets).set({ monthlyRemainingCents: 100 }).where(eq(wallets.id, w.marcusWalletId));
    try {
      const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(side.driveId, 'drive_wallet') });
      expect(gate).toMatchObject({ allowed: true, walletId: w.marcusWalletId, fallback: { from: 'drive_wallet', to: 'own_credits' } });
      expect((await holdsOf(w.marcusId)).map((h) => [h.walletId, h.fallbackFromWalletId])).toEqual([[w.marcusWalletId, side.walletId]]);

      const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 1 }).returning({ id: aiUsageLogs.id });
      expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 1, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');

      // 150¢: Marcus's 100¢, then 50¢ uncovered. The chosen Side Project wallet absorbs into its
      // parent by default (D20.2), so Jono's root carries the 50¢ — Marcus carries none.
      const marcusRow = await walletRow(w.marcusWalletId);
      expect([marcusRow.monthlyRemainingCents, marcusRow.debtCents]).toEqual([0, 0]);
      expect((await walletRow(side.jonoRootId)).debtCents).toBe(50);
      const debt = (await ledgerOf(w.marcusId)).filter((r) => r.entryType === 'adjustment');
      expect(debt.map((r) => [r.walletId, r.amountCents])).toEqual([[side.jonoRootId, -50]]);
    } finally {
      await db.delete(creditLedger).where(eq(creditLedger.userId, w.marcusId));
      await teardownPersonalDrive(side);
    }
  });

  it('WAL-6 (partial) a FOLLOW-ON call in a turn that fell back (a tool, a voice window) holds with the chosen wallet too, and so does a hold-less nested call; neither overshoot lands on the consumer', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    const side = await personalDrive(w, { allocationCents: 0, fallbackRule: 'own_credits' });
    await db.update(wallets).set({ monthlyRemainingCents: 200 }).where(eq(wallets.id, w.marcusWalletId));
    try {
      const first = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(side.driveId, 'drive_wallet') });
      expect(first).toMatchObject({ allowed: true, fallback: { from: 'drive_wallet', to: 'own_credits' }, fallbackFromWalletId: side.walletId });
      if (first.holdId) await db.delete(creditHolds).where(eq(creditHolds.id, first.holdId));

      // The follow-on names the turn's resolved source and carries the origin (turn-credit, call-metering).
      const followOnTarget = resolvedSpend(driveSpend(side.driveId, 'drive_wallet'), first.spendSource, first.fallbackFromWalletId);
      const followOn = await canConsumeAI(w.marcusId, 'free', { spend: followOnTarget });
      expect(followOn).toMatchObject({ allowed: true, walletId: w.marcusWalletId, fallbackFromWalletId: side.walletId });
      expect(followOn.fallback).toBeUndefined(); // reported once, by the turn's first call
      expect((await holdsOf(w.marcusId)).map((h) => h.fallbackFromWalletId)).toEqual([side.walletId]);
      const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 1 }).returning({ id: aiUsageLogs.id });
      await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 1, holdId: followOn.holdId, walletId: followOn.walletId });
      expect((await walletRow(w.marcusWalletId)).debtCents).toBe(0);
      expect((await walletRow(side.jonoRootId)).debtCents).toBe(0); // 150¢ fit Marcus's 200¢: no overshoot yet

      // A nested ask_agent call has no hold: its settle carries the origin from the turn's target.
      const [nested] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 1 }).returning({ id: aiUsageLogs.id });
      await consumeCredits({ aiUsageLogId: nested.id, userId: w.marcusId, costDollars: 1, walletId: w.marcusWalletId, fallbackFromWalletId: spendFallbackFromWalletId(followOnTarget) });
      // 50¢ left of Marcus's credits, 150¢ charged: the 100¢ overshoot lands on Jono's root (the chosen wallet's parent).
      expect((await walletRow(w.marcusWalletId)).debtCents).toBe(0);
      expect((await walletRow(side.jonoRootId)).debtCents).toBe(100);
    } finally {
      await db.delete(creditLedger).where(eq(creditLedger.userId, w.marcusId));
      await teardownPersonalDrive(side);
    }
  });

  it('WAL-6 (partial) own credits the consumer CHOSE still carry their own overshoot', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    await db.update(wallets).set({ monthlyRemainingCents: 100 }).where(eq(wallets.id, w.marcusWalletId));
    const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'own_credits') });
    expect(gate).toMatchObject({ allowed: true, walletId: w.marcusWalletId });
    expect(gate.fallback).toBeUndefined();
    expect((await holdsOf(w.marcusId)).map((h) => h.fallbackFromWalletId)).toEqual([null]);
    const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 1 }).returning({ id: aiUsageLogs.id });
    await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 1, holdId: gate.holdId, walletId: gate.walletId });
    expect((await walletRow(w.marcusWalletId)).debtCents).toBe(50);
  });

  it('WAL-6 (partial) a fallback settle the backfill cron RETRIES, and an orphan the sweep recovers, land overshoot exactly where the in-line settle would have — the chosen wallet\'s funder, never the consumer', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    const side = await personalDrive(w, { allocationCents: 0, fallbackRule: 'own_credits' });
    await db.update(wallets).set({ monthlyRemainingCents: 100 }).where(eq(wallets.id, w.marcusWalletId));
    try {
      // The in-line settle fails after the claim: the claim stays pending, carrying the fallback origin.
      const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(side.driveId, 'drive_wallet') });
      expect(gate).toMatchObject({ allowed: true, walletId: w.marcusWalletId, fallbackFromWalletId: side.walletId });
      const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 1 }).returning({ id: aiUsageLogs.id });
      const failOnce = vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('connection reset'));
      expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 1, holdId: gate.holdId, walletId: gate.walletId })).toBe('deferred');
      failOnce.mockRestore();
      const [claim] = await db.select().from(creditLedger).where(and(eq(creditLedger.aiUsageLogId, log.id), eq(creditLedger.entryType, 'usage')));
      expect(claim).toMatchObject({ consumeStatus: 'pending', walletId: w.marcusWalletId, fallbackFromWalletId: side.walletId });

      // The hold expires; the cron retries the claim with no hold to read the origin from.
      await db.delete(creditHolds).where(eq(creditHolds.userId, w.marcusId));
      await settlePendingLedgerRow(claim.id);
      // 150¢: Marcus's 100¢, then 50¢ uncovered — onto Jono's root (the chosen wallet's parent), not Marcus.
      expect(await walletRow(w.marcusWalletId)).toMatchObject({ monthlyRemainingCents: 0, debtCents: 0 });
      expect((await walletRow(side.jonoRootId)).debtCents).toBe(50);

      // An orphan (the usage row written, no claim at all) carries its wallet and origin on the row.
      await db.update(wallets).set({ monthlyRemainingCents: 100 }).where(eq(wallets.id, w.marcusWalletId));
      const [orphan] = await db.insert(aiUsageLogs).values({
        userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 1, walletId: w.marcusWalletId, metadata: { fallbackFromWalletId: side.walletId },
      }).returning();
      const [action] = computeBackfillActions([], [{ aiUsageLogId: orphan.id, userId: orphan.userId, costDollars: 1, walletId: orphan.walletId, metadata: orphan.metadata }], {});
      expect(action).toMatchObject({ kind: 'apply_orphan', walletId: w.marcusWalletId, fallbackFromWalletId: side.walletId });
      if (action.kind !== 'apply_orphan') throw new Error('expected an orphan settle');
      expect(await consumeCredits(action)).toBe('settled');
      expect((await walletRow(w.marcusWalletId)).debtCents).toBe(0);
      expect((await walletRow(side.jonoRootId)).debtCents).toBe(100);
    } finally {
      await db.delete(creditLedger).where(eq(creditLedger.userId, w.marcusId));
      await teardownPersonalDrive(side);
    }
  });

  it('WAL-6 (partial) a settle whose hold expired and that names no wallet FAILS CLOSED: nothing is charged to anyone — not the person\'s own credits — and no usage row can be recovered onto them', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet') });
    expect(gate).toMatchObject({ allowed: true, walletId: w.productWalletId });
    await db.delete(creditHolds).where(eq(creditHolds.userId, w.marcusId)); // expired and swept
    const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 1 }).returning({ id: aiUsageLogs.id });

    expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 1, holdId: gate.holdId })).toBe('unattributed');
    expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 1 })).toBe('unattributed');

    await expectNothingCharged(w);
    expect((await walletRow(w.productWalletId)).spentCents).toBe(0);
    expect(computeBackfillActions([], [{ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 1, walletId: null, metadata: {} }], {}))
      .toEqual([{ kind: 'unattributed_orphan', aiUsageLogId: log.id, userId: w.marcusId, costDollars: 1 }]);
  });

  it('WAL-6 overshoot on a covered drive-wallet reservation lands per the funder\'s choice (the pool\'s debt by default, the wallet\'s own when chosen), never on the member; the funder is told once per period; the pool\'s debt is forgiven by its next refill and the wallet\'s debt is netted by the next allocation reset', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 60, poolCents: 5_000 });
    const w = world;

    // (a) The gate reserves against the chosen wallet before the call; an uncovered reservation is refused.
    const gate = await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'drive_wallet') });
    expect(gate).toMatchObject({ allowed: true, walletId: w.productWalletId });
    expect((await holdsOf(w.marcusId)).map((h) => h.walletId)).toEqual([w.productWalletId]);
    expect(await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'drive_wallet') })).toMatchObject({ allowed: false });
    if (gate.holdId) await releaseHold(gate.holdId);

    // (b)(c) default: two overshooting calls — 60¢ from the allocation, 90¢ each into the POOL's debt.
    await driveWalletCall(w, 1);
    await driveWalletCall(w, 1);
    expect((await walletRow(w.poolId)).debtCents).toBe(180);
    expect(await walletRow(w.marcusWalletId)).toMatchObject({ monthlyRemainingCents: 5_000, debtCents: 0 });
    // (e) the funder (the org Owner) is told once this period; the member never.
    expect(await debtNoticesFor(w.jonoId)).toHaveLength(1);
    expect(await debtNoticesFor(w.marcusId)).toEqual([]);

    // (c) the funder chooses wallet debt: the next overshoot stays on Product itself.
    await db.update(wallets).set({ overshootChoice: 'wallet_debt' }).where(eq(wallets.id, w.productWalletId));
    await driveWalletCall(w, 1);
    expect(await walletRow(w.productWalletId)).toMatchObject({ spentCents: 60, debtCents: 90 });
    expect((await walletRow(w.poolId)).debtCents).toBe(180);
    expect((await walletRow(w.marcusWalletId)).debtCents).toBe(0);
    // (e) a wallet carrying debt shows "over" to whoever can see it.
    expect(await getDriveWallet(w.marcusId, w.productId, 'session')).toMatchObject({ ok: true, wallet: { status: 'over' } });

    // (d) the org's next invoice refills the pool: its debt is netted and forgiven, exactly as personal debt.
    const poolBefore = await walletRow(w.poolId);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, w.orgId));
    const startS = Math.floor(Date.now() / 1000) + 1;
    expect(await applyOrgPoolRefill({
      id: `in_${createId()}`,
      customer: org.stripeCustomerId,
      billing_reason: 'subscription_cycle',
      amount_paid: 5000,
      subtotal: 5000,
      parent: { subscription_details: { subscription: `sub_${createId()}` } },
      lines: { data: [{ amount: 5000, parent: { subscription_item_details: { subscription_item: 'si_org' } }, period: { start: startS, end: startS + 30 * 86_400 }, pricing: { price_details: { price: REFILL_PRICE_ID } } }] },
    }, { active: true, basePriceId: REFILL_PRICE_ID, seatPriceId: REFILL_SEAT_PRICE_ID })).toMatchObject({ kind: 'granted', walletId: w.poolId });
    const poolAfter = await walletRow(w.poolId);
    expect(poolAfter.debtCents).toBe(0);
    expect(poolAfter.monthlyRemainingCents).toBe(Math.max(0, poolBefore.monthlyRemainingCents - 180) + (poolAfter.monthlyAllowanceCents ?? 0));

    // (d) Product's allocation resets on the pool's new period: its own debt is netted from the new allocation.
    await resetDueAllocations({ now: new Date(startS * 1000 + 1_000) });
    expect(await walletRow(w.productWalletId)).toMatchObject({ spentCents: 60, debtCents: 0 });
    expect(await getDriveWallet(w.marcusId, w.productId, 'session')).toMatchObject({ ok: true, wallet: { status: 'active' } });
    expect((await walletRow(w.marcusWalletId)).debtCents).toBe(0);
  });

  it('WAL-5 every AI usage row records the wallet charged, holds are per wallet, and ledger, reconciliation and reset are keyed on wallet: a drive-wallet call holds and settles on the drive wallet with its allocation draw ledgered out of the pool and into it, and after donations, top-ups, seat spend, pool debt, a refill and a reset every wallet — the donor\'s, the lead\'s, the pool and both drive wallets — reconciles with its own rows', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 60, poolCents: 5_000 });
    const w = world;
    const side = await personalDrive(w, { allocationCents: 100, fallbackRule: null });
    try {
      // The opening balances, as the grants that funded them.
      await db.insert(creditLedger).values([
        { userId: w.jonoId, walletId: w.poolId, entryType: 'monthly_grant', bucket: 'monthly', amountCents: 5_000, consumeStatus: 'applied' },
        { userId: w.marcusId, walletId: w.marcusWalletId, entryType: 'monthly_grant', bucket: 'monthly', amountCents: 5_000, consumeStatus: 'applied' },
        { userId: w.jonoId, walletId: side.jonoRootId, entryType: 'monthly_grant', bucket: 'monthly', amountCents: 9_000, consumeStatus: 'applied' },
      ]);
      const ids = [w.poolId, w.productWalletId, w.marcusWalletId, side.jonoRootId, side.walletId];
      expect(await walletDriftAlerts({ toleranceCents: 0, limit: 10, walletIds: ids })).toEqual([]);

      // A donor (Marcus, from his own credits) and the leads' top-ups (the org's pool; Jono's own credits).
      expect(await donateToDriveWallet({ donorUserId: w.marcusId, targetWalletId: w.productWalletId, amountCents: 40, donationId: createId() })).toMatchObject({ kind: 'donated' });
      expect(await topUpDriveWallet(w.jonoId, w.productId, { amountCents: 30, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: true });
      expect(await topUpDriveWallet(w.jonoId, side.driveId, { amountCents: 50, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: true });

      // A drive-wallet call: held on Product, settled there, the usage row naming it; 150¢ = the
      // 60¢ allocation (drawn from the pool), the 70¢ of legs, then 20¢ overshoot onto the pool's debt.
      const gate = await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'drive_wallet') });
      expect(gate).toMatchObject({ allowed: true, walletId: w.productWalletId });
      expect((await holdsOf(w.marcusId)).map((h) => h.walletId)).toEqual([w.productWalletId]);
      const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 1 }).returning({ id: aiUsageLogs.id });
      expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 1, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');
      const [usage] = await db.select({ walletId: aiUsageLogs.walletId }).from(aiUsageLogs).where(eq(aiUsageLogs.id, log.id));
      expect(usage.walletId).toBe(w.productWalletId);
      const callRows = await db.select().from(creditLedger).where(eq(creditLedger.aiUsageLogId, log.id));
      expect(callRows.map((r) => [r.entryType, r.walletId, r.appliedCents ?? r.amountCents]).sort()).toEqual([
        ['adjustment', w.poolId, -20],
        ['allocation_draw', w.poolId, -60],
        ['allocation_draw', w.productWalletId, 60],
        ['usage', w.productWalletId, -130],
      ].sort());
      expect((await walletRow(w.poolId)).debtCents).toBe(20);

      // A personal drive's call draws its allocation from the lead's own root, ledgered there too.
      const sideGate = await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(side.driveId, 'drive_wallet') });
      const [sideLog] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 0.1 }).returning({ id: aiUsageLogs.id });
      expect(await consumeCredits({ aiUsageLogId: sideLog.id, userId: w.marcusId, costDollars: 0.1, holdId: sideGate.holdId, walletId: sideGate.walletId })).toBe('settled');
      // And a seat call on the pool.
      await seatCall(w, w.marcusId);

      expect(await walletDriftAlerts({ toleranceCents: 0, limit: 10, walletIds: ids })).toEqual([]);

      // Reset is per wallet: the pool's refill (its own grant row) and Product's allocation reset on the
      // pool's new period touch only those wallets, and the books still balance.
      const [org] = await db.select().from(organizations).where(eq(organizations.id, w.orgId));
      const startS = Math.floor(Date.now() / 1000) + 1;
      expect(await applyOrgPoolRefill({
        id: `in_${createId()}`,
        customer: org.stripeCustomerId,
        billing_reason: 'subscription_cycle',
        amount_paid: 5000,
        subtotal: 5000,
        parent: { subscription_details: { subscription: `sub_${createId()}` } },
        lines: { data: [{ amount: 5000, parent: { subscription_item_details: { subscription_item: 'si_org' } }, period: { start: startS, end: startS + 30 * 86_400 }, pricing: { price_details: { price: REFILL_PRICE_ID } } }] },
      }, { active: true, basePriceId: REFILL_PRICE_ID, seatPriceId: REFILL_SEAT_PRICE_ID })).toMatchObject({ kind: 'granted', walletId: w.poolId });
      const marcusBefore = await walletRow(w.marcusWalletId);
      await resetDueAllocations({ now: new Date(startS * 1000 + 1_000) });
      expect((await walletRow(w.productWalletId)).spentCents).toBe(0);
      expect(await walletRow(w.marcusWalletId)).toEqual(marcusBefore);
      expect(await walletDriftAlerts({ toleranceCents: 0, limit: 10, walletIds: ids })).toEqual([]);

      // And a wallet whose balance moves with no row is caught.
      await db.update(wallets).set({ topupRemainingCents: sql`${wallets.topupRemainingCents} + 7` }).where(eq(wallets.id, w.poolId));
      expect(await walletDriftAlerts({ toleranceCents: 0, limit: 10, walletIds: ids })).toEqual([
        expect.objectContaining({ walletId: w.poolId, kind: 'org_pool', orgId: w.orgId, driftCents: 7 }),
      ]);
    } finally {
      await teardownPersonalDrive(side);
    }
  });

  it('WAL-3 an allocation is a budget drawn against the parent as spend happens: setting it moves nothing, each settled call draws its share from the pool, and the unspent part never leaves the pool across a reset; a top-up leaves the pool at once and outlives the reset, and spend past the allocation drains the legs first-in first-out', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    const legsOf = async () => (await db.select({ kind: walletFundingLegs.funderKind, remaining: walletFundingLegs.remainingCents, at: walletFundingLegs.createdAt })
      .from(walletFundingLegs).where(eq(walletFundingLegs.walletId, w.productWalletId)))
      .sort((a, b) => a.at.getTime() - b.at.getTime()).map((l) => [l.kind, l.remaining]);

    // A 1,000¢ allocation is set: nothing has left the pool.
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(5_000);

    // One call settles 15¢: drawn from the pool as it happens.
    const gate = await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'drive_wallet') });
    const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 0.1 }).returning({ id: aiUsageLogs.id });
    expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 0.1, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(4_985);
    expect((await walletRow(w.productWalletId)).spentCents).toBe(15);

    // A 300¢ top-up leaves the pool at once, into a leg on Product; then a 50¢ donation leg.
    expect(await topUpDriveWallet(w.jonoId, w.productId, { amountCents: 300, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: true });
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(4_685);
    expect(await donateToDriveWallet({ donorUserId: w.marcusId, targetWalletId: w.productWalletId, amountCents: 50, donationId: createId() })).toMatchObject({ kind: 'donated' });
    expect(await legsOf()).toEqual([['owner', 300], ['donation', 50]]);

    // The pool refills and Product's allocation resets: the 985¢ never drawn stayed in the pool all
    // along (the refill only adds), spend restarts at zero, and the legs are untouched.
    const [org] = await db.select().from(organizations).where(eq(organizations.id, w.orgId));
    const startS = Math.floor(Date.now() / 1000) + 1;
    const refill = await applyOrgPoolRefill({
      id: `in_${createId()}`,
      customer: org.stripeCustomerId,
      billing_reason: 'subscription_cycle',
      amount_paid: 5000,
      subtotal: 5000,
      parent: { subscription_details: { subscription: `sub_${createId()}` } },
      lines: { data: [{ amount: 5000, parent: { subscription_item_details: { subscription_item: 'si_org' } }, period: { start: startS, end: startS + 30 * 86_400 }, pricing: { price_details: { price: REFILL_PRICE_ID } } }] },
    }, { active: true, basePriceId: REFILL_PRICE_ID, seatPriceId: REFILL_SEAT_PRICE_ID });
    expect(refill).toMatchObject({ kind: 'granted', walletId: w.poolId });
    const pool = await walletRow(w.poolId);
    expect(pool.monthlyRemainingCents).toBe(4_685 + pool.monthlyAllowanceCents);
    await resetDueAllocations({ now: new Date(startS * 1000 + 1_000) });
    expect(await walletRow(w.productWalletId)).toMatchObject({ spentCents: 0, topupRemainingCents: 350 });
    expect(await legsOf()).toEqual([['owner', 300], ['donation', 50]]);

    // 1,200¢ of spend: the whole 1,000¢ allocation from the pool, then 200¢ from the OLDEST leg first.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, startS * 1000 - Date.now() + 5)));
    const big = await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'drive_wallet') });
    const [bigLog] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 8 }).returning({ id: aiUsageLogs.id });
    expect(await consumeCredits({ aiUsageLogId: bigLog.id, userId: w.marcusId, costDollars: 8, holdId: big.holdId, walletId: big.walletId })).toBe('settled');
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(pool.monthlyRemainingCents - 1_000);
    expect(await walletRow(w.productWalletId)).toMatchObject({ spentCents: 1_000, topupRemainingCents: 150 });
    expect(await legsOf()).toEqual([['owner', 100], ['donation', 50]]);
    await expectWalletLegInvariant([w.productWalletId]);
  });

  // ---------------------------------------------------------------------------
  // SPEND-5: "Always my own credits", one global switch and one per drive. Either is absolute
  // (own credits or refuse), and it only ever narrows: it opens no wallet and passes no cap.
  // ---------------------------------------------------------------------------

  const alwaysOwnCredits = (w: World, on: boolean) =>
    db.update(wallets).set({ alwaysOwnCredits: on }).where(eq(wallets.id, w.marcusWalletId));
  const alwaysOwnCreditsIn = (w: World, driveId: string) =>
    db.insert(driveSpendOverrides).values({ userId: w.marcusId, driveId });

  it('SPEND-5 (partial) the GLOBAL switch on: a call that chose the seat or the drive wallet spends own credits; off: it spends what it chose', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    await alwaysOwnCredits(w, true);

    for (const source of ['seat_allowance', 'drive_wallet'] as const) {
      const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, source) });
      expect(gate, source).toMatchObject({ allowed: true, walletId: w.marcusWalletId, spendSource: 'own_credits', entitlementTier: 'free' });
      // The override is the person's own rule, not a drive rule moving the call: no fallback.
      expect(gate.fallback, source).toBeUndefined();
    }
    expect((await holdsOf(w.marcusId)).map((h) => h.walletId)).toEqual([w.marcusWalletId, w.marcusWalletId]);

    await alwaysOwnCredits(w, false);
    // Pro: the free tier's in-flight cap would count the two calls above.
    const off = await canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') });
    expect(off).toMatchObject({ allowed: true, walletId: w.poolId, spendSource: 'seat_allowance' });
  });

  it('SPEND-5 (partial) the PER-DRIVE switch holds in its drive only: own credits in Product, the chosen drive wallet in another drive', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    const side = await personalDrive(w, { allocationCents: 1_000, fallbackRule: null });
    try {
      await alwaysOwnCreditsIn(w, w.productId);

      const inProduct = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet') });
      expect(inProduct).toMatchObject({ allowed: true, walletId: w.marcusWalletId, spendSource: 'own_credits' });

      const elsewhere = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(side.driveId, 'drive_wallet') });
      expect(elsewhere).toMatchObject({ allowed: true, walletId: side.walletId, spendSource: 'drive_wallet' });
    } finally {
      await db.delete(driveSpendOverrides).where(eq(driveSpendOverrides.userId, w.marcusId));
      await teardownPersonalDrive(side);
    }
  });

  it('SPEND-5 (partial) an override never widens: with own credits empty it refuses by name and offers nothing — not the funded drive wallet, not the seat, not the drive\'s fallback', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    const side = await personalDrive(w, { allocationCents: 1_000, fallbackRule: 'own_credits' });
    try {
      await db.update(wallets).set({ monthlyRemainingCents: 0 }).where(eq(wallets.id, w.marcusWalletId));
      await alwaysOwnCredits(w, true);

      for (const [driveId, source] of [[w.productId, 'seat_allowance'], [w.productId, 'drive_wallet'], [side.driveId, 'drive_wallet']] as const) {
        const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(driveId, source) });
        expect(gate, `${driveId} ${source}`).toEqual({ allowed: false, reason: 'source_refused', refusal: { source: 'own_credits', reason: 'source_empty', options: [] } });
      }
      expect(await holdsOf(w.marcusId)).toEqual([]);
      expect(await ledgerOf(w.marcusId)).toEqual([]);
      expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(5_000);
      expect((await walletRow(side.walletId)).spentCents).toBe(0);
    } finally {
      await teardownPersonalDrive(side);
    }
  });

  it('SPEND-5 (partial) an override for a drive the person cannot spend in opens nothing there: a guest still has only their own credits', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    // Chris is a guest in Product: no drive wallet (D-OW-4), no seat (DRV-8). His override changes nothing he can reach.
    await db.insert(driveSpendOverrides).values({ userId: w.chrisId, driveId: w.productId });
    try {
      const gate = await canConsumeAI(w.chrisId, 'free', { spend: driveSpend(w.productId, 'drive_wallet') });
      expect(gate).toMatchObject({ allowed: true, spendSource: 'own_credits' });
      expect(gate.walletId).not.toBe(w.productWalletId);
      expect(gate.walletId).not.toBe(w.poolId);
      expect((await holdsOf(w.chrisId)).every((h) => h.walletId !== w.productWalletId && h.walletId !== w.poolId)).toBe(true);
    } finally {
      await db.delete(driveSpendOverrides).where(eq(driveSpendOverrides.userId, w.chrisId));
    }
  });

  it('SPEND-5 (partial) WAL-2 (partial) an override never passes the seat cap: a capped member who turns it on spends their own credits, and the pool pays nothing more', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    for (let call = 0; call < 4; call += 1) await seatCall(w, w.marcusId);
    await alwaysOwnCredits(w, true);

    const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'seat_allowance') });

    expect(gate).toMatchObject({ allowed: true, walletId: w.marcusWalletId, spendSource: 'own_credits' });
    expect(await seatChargedCents(w, w.marcusId)).toBe(100);
    expect((await holdsOf(w.marcusId)).map((h) => h.walletId)).toEqual([w.marcusWalletId]);
  });

  it('SPEND-5 (partial) the global switch can live only on a personal root wallet', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    for (const walletId of [w.poolId, w.productWalletId]) {
      const error = await db.update(wallets).set({ alwaysOwnCredits: true }).where(eq(wallets.id, walletId)).then(() => null, (e: unknown) => e);
      expect((error as { cause?: { code?: string } } | null)?.cause?.code, walletId).toBe('23514');
    }
  });

  it('SPEND-5 "Always my own credits" is an absolute per-user override, per drive and as one global switch: stored, read by the gate, own credits or refuse, never another wallet', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    const side = await personalDrive(w, { allocationCents: 1_000, fallbackRule: 'own_credits' });
    const inSide = () => canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(side.driveId, 'drive_wallet') });
    const inProduct = () => canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') });
    try {
      // Both off: each call spends the source it chose.
      expect(await inProduct()).toMatchObject({ allowed: true, walletId: w.poolId });
      expect(await inSide()).toMatchObject({ allowed: true, walletId: side.walletId });
      await db.delete(creditHolds).where(eq(creditHolds.userId, w.marcusId));

      // Per drive: on for Product only.
      await alwaysOwnCreditsIn(w, w.productId);
      expect(await inProduct()).toMatchObject({ allowed: true, walletId: w.marcusWalletId, spendSource: 'own_credits' });
      expect(await inSide()).toMatchObject({ allowed: true, walletId: side.walletId, spendSource: 'drive_wallet' });
      await db.delete(creditHolds).where(eq(creditHolds.userId, w.marcusId));
      await db.delete(driveSpendOverrides).where(eq(driveSpendOverrides.userId, w.marcusId));

      // Global: on everywhere.
      await alwaysOwnCredits(w, true);
      expect(await inProduct()).toMatchObject({ allowed: true, walletId: w.marcusWalletId, spendSource: 'own_credits' });
      expect(await inSide()).toMatchObject({ allowed: true, walletId: w.marcusWalletId, spendSource: 'own_credits' });
      await db.delete(creditHolds).where(eq(creditHolds.userId, w.marcusId));

      // Absolute: with own credits empty it refuses, offers nothing, and never falls back.
      await db.update(wallets).set({ monthlyRemainingCents: 0 }).where(eq(wallets.id, w.marcusWalletId));
      for (const gate of [await inProduct(), await inSide()]) {
        expect(gate).toEqual({ allowed: false, reason: 'source_refused', refusal: { source: 'own_credits', reason: 'source_empty', options: [] } });
      }
      expect(await holdsOf(w.marcusId)).toEqual([]);
      expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(5_000);
      expect((await walletRow(side.walletId)).spentCents).toBe(0);
    } finally {
      await db.delete(driveSpendOverrides).where(eq(driveSpendOverrides.userId, w.marcusId));
      await teardownPersonalDrive(side);
    }
  });

  it('WAL-2 an org pool is an org-owned wallet with no subject and no parent; a seat is the per-consumer monthly cap on the pool\'s own leg, not a separate row; a drive wallet has its drive as subject and the org pool (org drive) or the owner\'s personal wallet (personal drive) as parent', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const w = world;
    // A second org, whose pool only the real refill creates.
    const [acme] = await db.insert(organizations).values({ name: 'Acme', slug: `acme-${createId()}`, ownerId: w.jonoId, stripeCustomerId: `cus_${createId()}` }).returning();
    const drivesMade: string[] = [];
    try {
      // Acme has paid (the refill below is its paid invoice): no org trial, D-OW-30.
      await factories.createOrgSubscription(acme.id);
      await db.insert(orgMembers).values([
        { orgId: acme.id, userId: w.jonoId, role: 'OWNER' },
        { orgId: acme.id, userId: w.marcusId, role: 'MEMBER' },
        { orgId: acme.id, userId: w.chrisId, role: 'MEMBER' },
      ]);
      const startS = Math.floor(Date.now() / 1000) - 86_400;
      expect(await applyOrgPoolRefill({
        id: `in_${createId()}`, customer: acme.stripeCustomerId, billing_reason: 'subscription_cycle', amount_paid: 5000, subtotal: 5000,
        parent: { subscription_details: { subscription: `sub_${createId()}` } },
        lines: { data: [{ amount: 5000, parent: { subscription_item_details: { subscription_item: 'si_org' } }, period: { start: startS, end: startS + 30 * 86_400 }, pricing: { price_details: { price: REFILL_PRICE_ID } } }] },
      }, { active: true, basePriceId: REFILL_PRICE_ID, seatPriceId: REFILL_SEAT_PRICE_ID })).toMatchObject({ kind: 'granted' });

      // The org pool: owned by the org, no subject, no parent — one row.
      const acmeWallets = () => db.select().from(wallets).where(eq(wallets.orgId, acme.id));
      const [pool] = await acmeWallets();
      expect(pool).toMatchObject({ ownerType: 'org', orgId: acme.id, userId: null, subjectType: null, subjectId: null, parentWalletId: null });

      // A drive wallet on an org drive: its drive as subject, the pool as parent.
      const orgDrive = await factories.createDrive(w.jonoId, { name: 'Acme Product', slug: `acme-product-${createId()}`, orgId: acme.id, orgVisibility: 'OPEN' });
      drivesMade.push(orgDrive.id);
      await factories.createDriveMember(orgDrive.id, w.marcusId, { source: 'org' });
      await factories.createDriveMember(orgDrive.id, w.chrisId, { source: 'org' });
      expect(await createDriveWallet(w.jonoId, orgDrive.id, { allocationCents: 1_000 }, 'session')).toMatchObject({ ok: true });
      const [orgDriveWallet] = await db.select().from(wallets).where(and(eq(wallets.subjectType, 'drive'), eq(wallets.subjectId, orgDrive.id)));
      expect(orgDriveWallet).toMatchObject({ ownerType: 'org', orgId: acme.id, parentWalletId: pool.id });

      // A drive wallet on a personal drive: its drive as subject, the owner's personal wallet as parent.
      const personal = await factories.createDrive(w.jonoId, { name: 'Jono Notes', slug: `jono-notes-${createId()}` });
      drivesMade.push(personal.id);
      expect(await createDriveWallet(w.jonoId, personal.id, { allocationCents: 1_000 }, 'session')).toMatchObject({ ok: true });
      const [personalDriveWallet] = await db.select().from(wallets).where(and(eq(wallets.subjectType, 'drive'), eq(wallets.subjectId, personal.id)));
      const [jonoRoot] = await db.select().from(wallets).where(personalRootWalletOf(w.jonoId));
      expect(personalDriveWallet).toMatchObject({ ownerType: 'user', userId: w.jonoId, parentWalletId: jonoRoot.id });

      // A seat spends the pool's own leg — no seat row is ever created — capped per consumer per month.
      const seat = (userId: string) => canConsumeAI(userId, 'pro', { spend: driveSpend(orgDrive.id, 'seat_allowance') });
      const settle = async (userId: string, gate: Awaited<ReturnType<typeof seat>>) => {
        const [log] = await db.insert(aiUsageLogs).values({ userId, provider: 'openrouter', model: 'm', cost: COST_25C }).returning({ id: aiUsageLogs.id });
        await consumeCredits({ aiUsageLogId: log.id, userId, costDollars: COST_25C, holdId: gate.holdId, walletId: gate.walletId });
      };
      for (let call = 1; call <= 4; call += 1) {
        const gate = await seat(w.marcusId);
        expect(gate, `Marcus call ${call}`).toMatchObject({ allowed: true, walletId: pool.id, spendSource: 'seat_allowance' });
        await settle(w.marcusId, gate);
      }
      expect(await seat(w.marcusId)).toMatchObject({ allowed: false, refusal: { source: 'seat_allowance', reason: 'source_cap_reached' } });
      const chrisGate = await seat(w.chrisId);
      expect(chrisGate).toMatchObject({ allowed: true, walletId: pool.id });
      await settle(w.chrisId, chrisGate);
      expect((await acmeWallets()).map((row) => row.id).sort()).toEqual([pool.id, orgDriveWallet.id].sort());
    } finally {
      await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
      await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
      await db.delete(wallets).where(and(eq(wallets.subjectType, 'drive'), inArray(wallets.subjectId, drivesMade)));
      await db.delete(wallets).where(eq(wallets.orgId, acme.id));
      await db.delete(drives).where(inArray(drives.id, drivesMade));
      await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, acme.id));
      await db.delete(organizations).where(eq(organizations.id, acme.id));
    }
  });
  // ---------------------------------------------------------------------------
  // Compute and the seat (fe9db1nm; supersedes the 2026-09-28 exclusion, whose reason was the drive
  // lead): a member's PERSON-RUN compute on the pool (kind 'compute': sandbox runs, the terminal,
  // browsers, their session's storage) is their draw on the pool and counts toward the same
  // per-consumer cap as their AI (WAL-2), at admission under the pool lock and at settlement. A
  // DRIVE accrual no person ran (kind 'drive_compute': env/app storage, wakes, awake time — recorded
  // under the drive LEAD) is never anyone's seat draw. Pinned both ways, for settled rows, holds in
  // flight and the settle-time overshoot record.
  // ---------------------------------------------------------------------------

  const usageRow = (w: World, spendKind: SpendKind, chargeMillicents: number, userId = w.marcusId) =>
    db.insert(creditLedger).values({ userId, walletId: w.poolId, entryType: 'usage', bucket: 'monthly', amountCents: -Math.round(chargeMillicents / 1000), appliedCents: 0, chargeMillicents, consumeStatus: 'applied', spendKind });
  const holdRow = (w: World, spendKind: SpendKind, estCents: number) =>
    db.insert(creditHolds).values({ userId: w.marcusId, walletId: w.poolId, estCents, spendKind, expiresAt: new Date(Date.now() + 600_000) });
  /** A person-run compute reservation on the org pool, through the real compute gate. */
  const memberCompute = (w: World, userId: string) =>
    gateComputeCharge(computeChargeFor({ kind: 'org', orgId: w.orgId }, userId), { estCostCents: 25, maxInFlight: 50 });
  /** A drive accrual's reservation on the org pool (an app wake), recorded under the lead. */
  const driveAccrual = (w: World, leadId: string) =>
    gateComputeCharge(driveAccrualChargeFor({ kind: 'org', orgId: w.orgId }, leadId), { estCostCents: 25, maxInFlight: 50 });

  it('WAL-2 (partial) [D-OW-28] a settled COMPUTE row on the pool counts against the person it is recorded under like AI — what they ran, or what an env or app they created accrued', async () => {
    if (!dbAvailable) return;
    for (const kind of ['compute', 'drive_compute'] as const) {
      world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
      const w = world;
      await usageRow(w, kind, 90_000);

      expect((await seatCountedAt(w, w.marcusId, DEFAULT_SEAT_ALLOWANCE_CENTS)).usage.periodChargedMillicents, kind).toBe(90_000);
      expect(await seatGate(w, w.marcusId), kind).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
      expect(await memberCompute(w, w.marcusId), kind).toEqual({ allowed: false, reason: 'org_member_cap_reached', orgRefusal: 'org_member_cap_reached' });
      expect(await driveAccrual(w, w.marcusId), kind).toEqual({ allowed: false, reason: 'org_member_cap_reached', orgRefusal: 'org_member_cap_reached' });
      expect(await holdsOf(w.marcusId), kind).toEqual([]);
      await teardown(w);
      world = null;
    }
  });
  it('WAL-2 (partial) [D-OW-28] a COMPUTE hold in flight reserves seat room like an AI hold, whichever kind it is', async () => {
    if (!dbAvailable) return;
    for (const kind of ['compute', 'drive_compute'] as const) {
      world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
      const w = world;
      await holdRow(w, kind, 90);

      expect((await seatCountedAt(w, w.marcusId, DEFAULT_SEAT_ALLOWANCE_CENTS)).usage.periodReservedCents, kind).toBe(90);
      expect(await seatGate(w, w.marcusId), kind).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
      await teardown(w);
      world = null;
    }
  });
  it('WAL-2 (partial) AI and person-run compute share ONE allowance: a member at the cap through AI cannot start compute on the pool, and compute fills what AI left', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    // 50¢ of seat AI, then compute holds take the other 50¢ in two 25¢ reservations.
    await seatCall(w, w.marcusId, undefined, 'pro');
    await seatCall(w, w.marcusId, undefined, 'pro');
    expect(await memberCompute(w, w.marcusId)).toMatchObject({ allowed: true, walletId: w.poolId });
    expect(await memberCompute(w, w.marcusId)).toMatchObject({ allowed: true, walletId: w.poolId });

    expect(await memberCompute(w, w.marcusId)).toMatchObject({ allowed: false, orgRefusal: 'org_member_cap_reached' });
    expect(await seatGate(w, w.marcusId)).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
    // The pool itself is nowhere near empty: it is the member's cap that refused.
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(900_000 - 50);
  });

  it('WAL-2 (partial) [D-OW-28] accruals recorded under the drive LEAD (an env or app with no cost owner) fill the LEAD\'s seat: the lead is accountable for the drive', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await usageRow(w, 'drive_compute', 300_000, w.jonoId);

    expect(await driveAccrual(w, w.jonoId)).toMatchObject({ allowed: false, orgRefusal: 'org_member_cap_reached' });
    expect(await memberCompute(w, w.jonoId)).toMatchObject({ allowed: false, orgRefusal: 'org_member_cap_reached' });
    // Never Marcus's: his allowance is whole.
    expect(await memberCompute(w, w.marcusId)).toMatchObject({ allowed: true, walletId: w.poolId });
  });
  it('WAL-2 (partial) two SIMULTANEOUS person-run compute starts against an allowance with room for one: exactly one passes, decided under the pool lock', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    // 75¢ of the 100¢ allowance spent on seat AI: room for one 25¢ compute reservation.
    for (let call = 0; call < 3; call += 1) await seatCall(w, w.marcusId, undefined, 'pro');

    const both = await withSlowHoldInserts(w.marcusId, () => Promise.all([0, 1].map(() => memberCompute(w, w.marcusId))));

    expect(both.filter((g) => g.allowed)).toHaveLength(1);
    expect(both.find((g) => !g.allowed)).toEqual({ allowed: false, reason: 'org_member_cap_reached', orgRefusal: 'org_member_cap_reached' });
    expect((await holdsOf(w.marcusId)).map((h) => [h.walletId, h.estCents, h.spendKind])).toEqual([[w.poolId, 25, 'compute']]);
  });

  it('WAL-2 (partial) WAL-6 (partial) person-run compute that beats its estimate at the cap is bound at SETTLEMENT: the pool pays, the member ends AT the cap, and the next start is refused', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    for (let call = 0; call < 3; call += 1) await seatCall(w, w.marcusId, undefined, 'pro');
    const gate = await memberCompute(w, w.marcusId);
    expect(gate).toMatchObject({ allowed: true, walletId: w.poolId });
    const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'sandbox', model: 'machine', cost: 2 * COST_25C }).returning({ id: aiUsageLogs.id });

    // Admitted on 25¢, the run really cost 50¢: 125¢ of Marcus's draw against his 100¢.
    expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 2 * COST_25C, holdId: gate.allowed ? gate.holdId : undefined, walletId: w.poolId, spendKind: 'compute' })).toBe('settled');

    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(900_000 - 125);
    expect(await overshootRows(w.marcusId)).toEqual([['seat_overshoot_month', 25_000]]);
    expect((await seatCounted(w, w.marcusId)).usage.periodChargedMillicents).toBe(100_000);
    expect(await memberCompute(w, w.marcusId)).toMatchObject({ allowed: false, orgRefusal: 'org_member_cap_reached' });
  });

  it('WAL-2 (partial) [D-OW-28] recordSeatOvershoot records the pool\'s absorbed overshoot whichever kind settles — AI, compute a person ran, or an env or app accrual', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    // 150¢ of seat-counted spend against the 100¢ allowance with no overshoot row recorded yet: 50¢ is past the cap.
    await usageRow(w, 'ai', 60_000);
    await usageRow(w, 'compute', 40_000);
    await usageRow(w, 'drive_compute', 50_000);
    const record = (spendKind: SpendKind) =>
      db.transaction((tx) => recordSeatOvershoot(tx, { walletId: w.poolId, userId: w.marcusId, aiUsageLogId: null, claimLedgerId: null, spendKind }));

    expect(await record('drive_compute')).toEqual({ monthMc: 50_000, dayMc: 0 });
    expect(await overshootRows(w.marcusId)).toEqual([['seat_overshoot_month', 50_000]]);
    // Already recorded: the same facts settled again add nothing, whichever kind settles.
    expect(await record('ai')).toEqual({ monthMc: 0, dayMc: 0 });
    expect(await record('compute')).toEqual({ monthMc: 0, dayMc: 0 });
  });

  // ---------------------------------------------------------------------------
  // POL-7: the seat allowance amount and the wallet fallback rule are the ORG's policy, read at
  // admission (under the pool lock) and at settlement. The caps' own guards are unchanged.
  // ---------------------------------------------------------------------------

  const setPolicies = (w: World, policies: Record<string, unknown>) =>
    db.update(organizations).set({ policies }).where(eq(organizations.id, w.orgId));
  /** What the seat reads for `userId` against an explicit policy allowance: the gate's own read. */
  async function seatCountedAt(w: World, userId: string, policySeatAllowanceCents: number) {
    const poolRow = await walletRow(w.poolId);
    return loadSeatCapFacts(db, { poolId: w.poolId, poolPeriodStart: poolRow.monthlyPeriodStart, userId, policySeatAllowanceCents, now: new Date() });
  }

  it('POL-7 (partial) with no policy stored the seat allowance is the default amount — a member is capped, never unlimited', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    expect((await db.select({ p: organizations.policies }).from(organizations).where(eq(organizations.id, w.orgId)))[0].p).toEqual({});

    expect(await spendUntilRefused(w, w.marcusId, 50)).toBe(DEFAULT_SEAT_ALLOWANCE_CENTS / 25);
    expect(await seatGate(w, w.marcusId)).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
    // Whatever is stored, an allowance is never unlimited: garbage reads as zero room, not as no cap.
    await setPolicies(w, { seatAllowanceCents: 'lots' });
    expect(await seatGate(w, w.marcusId)).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
    await setPolicies(w, { seatAllowanceCents: null });
    expect(await seatGate(w, w.marcusId)).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
  });

  it('POL-7 (partial) an org policy RAISING the allowance opens room at the very next admission, no restart', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    expect(await spendUntilRefused(w, w.marcusId)).toBe(4);
    await setPolicies(w, { seatAllowanceCents: 200 });
    // 100¢ spent of a new 200¢ allowance: exactly four more 25¢ calls.
    expect(await spendUntilRefused(w, w.marcusId)).toBe(4);
  });

  it('POL-7 (partial) an org policy LOWERED below what is already spent leaves no room — never negative — until the pool refills', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    for (let call = 1; call <= 3; call += 1) await seatCallCosting(w, w.marcusId, COST_25C);
    await setPolicies(w, { seatAllowanceCents: 50 });

    // 75¢ spent against 50¢: the seat reads its cap (50¢), not 75¢ and not negative room.
    expect((await seatCountedAt(w, w.marcusId, 50)).usage.periodChargedMillicents).toBe(50_000);
    expect(await seatGate(w, w.marcusId)).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
  });

  it('POL-7 (partial) a per-consumer cap on the pool leg still beats the org policy amount', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await setPolicies(w, { seatAllowanceCents: 150 });
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, monthlyCapCents: 50 });
    expect(await spendUntilRefused(w, w.marcusId)).toBe(2);
    // Another member with no cap of their own gets the policy amount.
    expect(await spendUntilRefused(w, await addLena(w), 50)).toBe(6);
  }, 30_000);

  it('POL-7 (partial) WAL-2 (partial) SETTLEMENT judges against the policy amount too: the past-cap part of a real charge is recorded as the pool\'s overshoot', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await setPolicies(w, { seatAllowanceCents: 200 });
    for (let call = 1; call <= 7; call += 1) await seatCallCosting(w, w.marcusId, COST_25C);

    // 175¢ of 200¢ spent. The eighth call is admitted on its 25¢ estimate and really costs 50¢.
    const logId = await seatCallCosting(w, w.marcusId, 2 * COST_25C);

    const overshoot = (await ledgerOf(w.marcusId)).filter((r) => r.entryType.startsWith('seat_overshoot'));
    expect(overshoot.map((r) => [r.entryType, r.aiUsageLogId, r.chargeMillicents])).toEqual([['seat_overshoot_month', logId, 25_000]]);
    expect((await seatCountedAt(w, w.marcusId, 200)).usage.periodChargedMillicents).toBe(200_000);
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(900_000 - 225);
  });

  it('WAL-6 (partial) SEAT-9 (partial) [D-OW-32] a LAPSED org pays nothing for a member\'s own-credits fallback: the fallback is shown, the overshoot stays on the member, the pool\'s debt does not move', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await setPolicies(w, { walletFallback: 'own_credits' });
    await db.update(orgSubscriptions).set({ status: 'canceled' }).where(eq(orgSubscriptions.orgId, w.orgId));
    await db.update(wallets).set({ debtCents: 53 }).where(eq(wallets.id, w.poolId));
    await db.update(wallets).set({ monthlyRemainingCents: 40, topupRemainingCents: 0 }).where(eq(wallets.id, w.marcusWalletId));

    const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 });
    expect(gate).toMatchObject({ allowed: true, walletId: w.marcusWalletId, spendSource: 'own_credits', fallback: { from: 'drive_wallet', to: 'own_credits' } });
    expect(gate.fallbackFromWalletId).toBeUndefined();
    expect((await holdsOf(w.marcusId)).map((h) => h.fallbackFromWalletId)).toEqual([null]);

    const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 1 }).returning({ id: aiUsageLogs.id });
    expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 1, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');

    const pool = await walletRow(w.poolId);
    const product = await walletRow(w.productWalletId);
    const marcus = await walletRow(w.marcusWalletId);
    expect([pool.debtCents, pool.monthlyRemainingCents]).toEqual([53, 900_000]);
    expect([product.spentCents, product.debtCents]).toEqual([0, 0]);
    // The money invariant: the 150¢ charge = what left Marcus's wallet + the debt it carries.
    expect([marcus.monthlyRemainingCents, marcus.debtCents]).toEqual([0, 110]);
    const rows = await ledgerOf(w.marcusId);
    const usage = rows.find((r) => r.entryType === 'usage');
    const debt = rows.filter((r) => r.entryType === 'adjustment');
    expect(-(usage?.appliedCents ?? 0) + debt.reduce((s, r) => s - r.amountCents, 0)).toBe(150);
    expect(debt.map((r) => r.walletId)).toEqual([w.marcusWalletId]);
  });

  it('WAL-6 (partial) [D-OW-32] a fallback whose chosen leg is paused by the time it settles (the org lapsed mid-turn) still lands nothing on the paused leg', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;
    await db.update(wallets).set({ debtCents: 53 }).where(eq(wallets.id, w.poolId));
    await db.update(wallets).set({ monthlyRemainingCents: 40, topupRemainingCents: 0 }).where(eq(wallets.id, w.marcusWalletId));
    // A follow-on of a turn that fell back off Product: then the org lapses before it settles.
    await db.update(orgSubscriptions).set({ status: 'canceled' }).where(eq(orgSubscriptions.orgId, w.orgId));
    const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 1 }).returning({ id: aiUsageLogs.id });
    await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 1, walletId: w.marcusWalletId, fallbackFromWalletId: w.productWalletId });
    expect((await walletRow(w.poolId)).debtCents).toBe(53);
    expect((await walletRow(w.marcusWalletId)).debtCents).toBe(110);
  });

  /**
   * #2763 review P2-1: the settle-time re-check of the D-OW-32 ruling (credit-consume lockFallbackFrom). A turn ADMITTED
   * while its org was paid fell back off an empty Product leg onto Marcus's own credits, so its hold carries
   * fallbackFromWalletId = Product. Between admission and settle the leg stops absorbing: the org lapses, or an admin
   * hits the kill switch. The overshoot must stay on Marcus, never reach the pool's debt, and the money adds up.
   */
  const admitFallbackThen = async (w: World, between: () => Promise<unknown>) => {
    await setPolicies(w, { walletFallback: 'own_credits' });
    await db.update(wallets).set({ debtCents: 53 }).where(eq(wallets.id, w.poolId));
    await db.update(wallets).set({ monthlyRemainingCents: 40, topupRemainingCents: 0 }).where(eq(wallets.id, w.marcusWalletId));
    const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 });
    expect(gate).toMatchObject({ allowed: true, walletId: w.marcusWalletId, spendSource: 'own_credits', fallback: { from: 'drive_wallet', to: 'own_credits' }, fallbackFromWalletId: w.productWalletId });
    expect((await holdsOf(w.marcusId)).map((h) => h.fallbackFromWalletId)).toEqual([w.productWalletId]);
    await between();
    const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 1 }).returning({ id: aiUsageLogs.id });
    expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 1, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');
  };

  const expectOvershootStaysOnMarcus = async (w: World) => {
    const pool = await walletRow(w.poolId);
    const product = await walletRow(w.productWalletId);
    const marcus = await walletRow(w.marcusWalletId);
    expect([pool.debtCents, pool.monthlyRemainingCents]).toEqual([53, 900_000]);
    expect([product.spentCents, product.debtCents]).toEqual([0, 0]);
    // The money invariant: the 150¢ charge = what left Marcus's wallet + the debt it carries, all on Marcus.
    expect([marcus.monthlyRemainingCents, marcus.debtCents]).toEqual([0, 110]);
    const rows = await ledgerOf(w.marcusId);
    const usage = rows.find((r) => r.entryType === 'usage');
    const debt = rows.filter((r) => r.entryType === 'adjustment');
    expect(-(usage?.appliedCents ?? 0) + debt.reduce((sum, r) => sum - r.amountCents, 0)).toBe(150);
    expect(debt.map((r) => r.walletId)).toEqual([w.marcusWalletId]);
    expect(await holdsOf(w.marcusId)).toEqual([]);
  };

  it('WAL-6 (partial) SEAT-9 (partial) [D-OW-32] the org LAPSES between admission and settle: a fallback admitted while paid carries nothing back to the pool', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 0, poolCents: 900_000 });
    const w = world;
    await admitFallbackThen(w, () => db.update(orgSubscriptions).set({ status: 'canceled' }).where(eq(orgSubscriptions.orgId, w.orgId)));
    await expectOvershootStaysOnMarcus(w);
  });

  it('WAL-6 (partial) WAL-7 (partial) [D-OW-32] the chosen leg is KILL-SWITCHED between admission and settle (org still paid): the paused leg absorbs nothing', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 0, poolCents: 900_000 });
    const w = world;
    await admitFallbackThen(w, () => db.update(wallets).set({ status: 'paused' }).where(eq(wallets.id, w.productWalletId)));
    await expectOvershootStaysOnMarcus(w);
  });

  it('POL-7 an org fallback rule of own credits moves an empty drive wallet onto the person\'s own credits, shows it, and a drive swapping it back to seat allowance refuses', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 0, poolCents: 900_000 });
    const w = world;
    const chooseDriveWallet = () => canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet') });
    await setPolicies(w, { walletFallback: 'own_credits' });

    const moved = await chooseDriveWallet();
    expect(moved).toMatchObject({ allowed: true, walletId: w.marcusWalletId, spendSource: 'own_credits', fallback: { from: 'drive_wallet', to: 'own_credits' } });
    await db.delete(creditHolds).where(eq(creditHolds.userId, w.marcusId));

    // A drive rule that swaps the org's own-credits fallback for seat allowance would spend org money: refuse.
    await db.update(wallets).set({ fallbackRule: 'seat_allowance' }).where(eq(wallets.id, w.productWalletId));
    expect(await chooseDriveWallet()).toMatchObject({ allowed: false, refusal: { source: 'drive_wallet', reason: 'source_empty' } });
    expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(900_000);
  });

  it('POL-7 the wallet fallback rule comes from the org policy: default refuses, seat allowance applies, and a drive can only restate it or refuse', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 0, poolCents: 900_000 });
    const w = world;
    const chooseDriveWallet = () => canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet') });
    const driveRule = (fallbackRule: 'refuse' | 'seat_allowance' | 'own_credits' | null) =>
      db.update(wallets).set({ fallbackRule }).where(eq(wallets.id, w.productWalletId));

    // No policy: the empty drive wallet refuses; nothing is charged anywhere.
    expect(await chooseDriveWallet()).toMatchObject({ allowed: false, refusal: { source: 'drive_wallet', reason: 'source_empty' } });

    await setPolicies(w, { walletFallback: 'seat_allowance' });
    const moved = await chooseDriveWallet();
    expect(moved).toMatchObject({ allowed: true, walletId: w.poolId, spendSource: 'seat_allowance', fallback: { from: 'drive_wallet', to: 'seat_allowance' } });
    await db.delete(creditHolds).where(eq(creditHolds.userId, w.marcusId));

    // A drive that restates the org rule keeps it; one that says refuse refuses; one that swaps it refuses.
    await driveRule('seat_allowance');
    expect(await chooseDriveWallet()).toMatchObject({ allowed: true, spendSource: 'seat_allowance' });
    await db.delete(creditHolds).where(eq(creditHolds.userId, w.marcusId));
    await driveRule('refuse');
    expect(await chooseDriveWallet()).toMatchObject({ allowed: false, refusal: { reason: 'source_empty' } });
    await driveRule('own_credits');
    expect(await chooseDriveWallet()).toMatchObject({ allowed: false, refusal: { reason: 'source_empty' } });
    // The person's own credits were never touched by any of it.
    expect((await walletRow(w.marcusWalletId)).monthlyRemainingCents).toBe(5_000);
  });
});
