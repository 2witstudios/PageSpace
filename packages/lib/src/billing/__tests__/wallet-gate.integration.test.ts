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
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { driveSpendOverrides, personalRootWalletOf, walletConsumerCaps, wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { loggers } from '../../logging/logger-config';
import { canConsumeAI } from '../credit-gate';
import { consumeCredits } from '../credit-consume';
import { PERSONAL_SPEND, conversationSpend, driveSpend } from '../spend-target';
import { DEFAULT_SEAT_ALLOWANCE_CENTS } from '../wallet-core';
import { loadSeatCapFacts } from '../seat-allowance';
import { applyOrgPoolRefill, donateToDriveWallet } from '../wallet-funding-shell';
import { reconcileOpenRouterCosts } from '../cost-reconcile';
import { createDriveWallet } from '../../services/drive-wallet-service';
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

  it('SPEND-4 (partial) a conversation with nothing chosen and no default refuses; it never defaults to a wallet', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const conversationId = await conversationIn(world.productId, world.marcusId, null);

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: conversationSpend(world.productId, conversationId) });

    expect(gate).toMatchObject({ allowed: false, reason: 'source_refused', refusal: { source: null, reason: 'no_source_chosen' } });
    await expectNothingCharged(world);
  });

  it('SPEND-3 (partial) with nothing chosen the drive default preselects before the person\'s default', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    const conversationId = await conversationIn(world.productId, world.marcusId, null);
    await db.update(wallets).set({ defaultSpendSource: 'own_credits' }).where(eq(wallets.id, world.marcusWalletId));

    const personal = await canConsumeAI(world.marcusId, 'free', { spend: conversationSpend(world.productId, conversationId) });
    expect(personal).toMatchObject({ allowed: true, walletId: world.marcusWalletId, spendSource: 'own_credits' });

    await db.update(wallets).set({ defaultSpendSource: 'drive_wallet' }).where(eq(wallets.id, world.productWalletId));
    const drive = await canConsumeAI(world.marcusId, 'free', { spend: conversationSpend(world.productId, conversationId) });
    expect(drive).toMatchObject({ allowed: true, walletId: world.productWalletId, spendSource: 'drive_wallet' });
  });
  it('SPEND-3 (partial) a stored choice is read only from the caller\'s OWN conversation: naming someone else\'s conversation chooses nothing', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 5_000 });
    // Jono's conversation in Product stores Product's wallet, a wallet Marcus may also spend.
    const jonosConversation = await conversationIn(world.productId, world.jonoId, world.productWalletId);

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: conversationSpend(world.productId, jonosConversation) });

    expect(gate).toMatchObject({ allowed: false, reason: 'source_refused', refusal: { source: null, reason: 'no_source_chosen' } });
    await expectNothingCharged(world);
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

  it('WAL-2 (partial) calls in flight count against the seat allowance: concurrent reservations cannot pass the cap together', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, poolCents: 900_000 });
    const w = world;

    const gates = await Promise.all(Array.from({ length: 6 }, () => canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') })));

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

    const both = await Promise.all([0, 1].map(() => canConsumeAI(w.marcusId, 'pro', { spend: driveSpend(w.productId, 'seat_allowance') })));

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
  });

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
    expect(await overshootRows(w.marcusId)).toEqual([['seat_overshoot_month', 25_000], ['seat_overshoot_month', -25_000]]);
    expect((await seatCounted(w, w.marcusId)).usage.periodChargedMillicents).toBe(86_000);
    // 14¢ left: a 25¢ reservation does not fit.
    expect(await seatGate(w, w.marcusId)).toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
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
      lines: { data: [{ amount: 5000, period: { start: startS, end: startS + 30 * 86_400 } }] },
    }, { active: true });
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
      await db.insert(orgMembers).values([
        { orgId: acme.id, userId: w.jonoId, role: 'OWNER' },
        { orgId: acme.id, userId: w.marcusId, role: 'MEMBER' },
        { orgId: acme.id, userId: w.chrisId, role: 'MEMBER' },
      ]);
      const startS = Math.floor(Date.now() / 1000) - 86_400;
      expect(await applyOrgPoolRefill({
        id: `in_${createId()}`, customer: acme.stripeCustomerId, billing_reason: 'subscription_cycle', amount_paid: 5000, subtotal: 5000,
        parent: { subscription_details: { subscription: `sub_${createId()}` } },
        lines: { data: [{ amount: 5000, period: { start: startS, end: startS + 30 * 86_400 } }] },
      }, { active: true })).toMatchObject({ kind: 'granted' });

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
      await db.delete(organizations).where(eq(organizations.id, acme.id));
    }
  });
});
