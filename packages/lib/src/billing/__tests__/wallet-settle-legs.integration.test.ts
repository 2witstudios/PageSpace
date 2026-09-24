/**
 * A drive-wallet settle against the funding legs, on a real Postgres (Spec WAL-3, WAL-4,
 * WAL-5, WAL-6; D-OW-13). Where c3's settle (credit-consume) and c5's legs
 * (wallet-funding-shell) meet — the seam neither lane tested alone:
 *
 *   - the invariant wallets.topupRemainingCents == SUM(wallet_funding_legs.remainingCents)
 *     holds after every settle, with an owner leg AND a donation leg present, and the
 *     spend draws the legs FIFO so the donor attribution survives;
 *   - a refund after a settle cannot give back cents that were already spent;
 *   - a settle names the wallet its HOLD was placed on, whatever the caller passed;
 *   - one global lock order — drive (child) wallet, then its parent/root wallet, then the
 *     funding legs — so a settle never deadlocks against a donation or a refund.
 *
 * Fixture: Jono owns a personal drive whose wallet is a child of his personal root; Ada
 * is a member who donates to it. Requires DATABASE_URL → a migrated Postgres; fails loudly
 * without one (requireDb). Deletes every row it creates, children before parents, users last.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray, asc, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { wallets, walletFundingLegs } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { loggers } from '../../logging/logger-config';
import { consumeCredits } from '../credit-consume';
import { donateToDriveWallet, refundFundingLeg } from '../wallet-funding-shell';
import { expectWalletLegInvariant, installWalletLegInvariantTrigger, WALLET_LEG_INVARIANT_GUC } from '../../test/wallet-leg-invariant';

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

// A 1× markup so a cost in dollars settles as exactly that many whole cents.
const AT_COST_BPS = 10_000;

interface World {
  jonoId: string;
  adaId: string;
  driveId: string;
  jonoRootId: string;
  adaRootId: string;
  driveWalletId: string;
  ownerLegId: string;
  userIds: string[];
}

let world: World | null = null;

/**
 * Wallet ids are chosen so the parent sorts BEFORE the child: an id-sorted lock order then
 * locks parent first, the inversion of the settle's child-first order (P2-4).
 */
async function build(input: { ownerLegCents: number; jonoRootCents?: number; driveAllocationCents?: number }): Promise<World> {
  const jono = await factories.createUser({ name: 'Jono', subscriptionTier: 'free' });
  const ada = await factories.createUser({ name: 'Ada Brennan', subscriptionTier: 'free' });
  const drive = await factories.createDrive(jono.id, { name: 'Field notes', slug: `field-notes-${createId()}` });
  await factories.createDriveMember(drive.id, ada.id, { source: 'invite' });

  const period = { monthlyPeriodStart: new Date(), monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000) };
  const [jonoRoot] = await db.insert(wallets).values({
    id: `a${createId()}`,
    userId: jono.id,
    monthlyRemainingCents: input.jonoRootCents ?? 5_000,
    ...period,
  }).returning();
  const [adaRoot] = await db.insert(wallets).values({ userId: ada.id, monthlyRemainingCents: 5_000, ...period }).returning();
  // The drive wallet and its owner leg in ONE transaction: the row mirrors its legs at
  // every commit (the integration setup's invariant trigger checks exactly that).
  const { driveWallet, ownerLeg } = await db.transaction(async (tx) => {
    const [w] = await tx.insert(wallets).values({
      id: `z${createId()}`,
      userId: jono.id,
      subjectType: 'drive',
      subjectId: drive.id,
      parentWalletId: jonoRoot.id,
      monthlyAllowanceCents: input.driveAllocationCents ?? 0,
      topupRemainingCents: input.ownerLegCents,
    }).returning();
    // The owner's top-up arrived first, so FIFO draws it before any later donation.
    const [leg] = await tx.insert(walletFundingLegs).values({
      walletId: w.id,
      funderKind: 'owner',
      funderUserId: jono.id,
      originalCents: input.ownerLegCents,
      remainingCents: input.ownerLegCents,
      nonRefundable: false,
      createdAt: new Date(Date.now() - 60_000),
    }).returning();
    return { driveWallet: w, ownerLeg: leg };
  });
  return {
    jonoId: jono.id,
    adaId: ada.id,
    driveId: drive.id,
    jonoRootId: jonoRoot.id,
    adaRootId: adaRoot.id,
    driveWalletId: driveWallet.id,
    ownerLegId: ownerLeg.id,
    userIds: [jono.id, ada.id],
  };
}

async function teardown(w: World): Promise<void> {
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  // Legs cascade with their wallet; child wallets before their parent.
  await db.delete(wallets).where(eq(wallets.id, w.driveWalletId));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(drives).where(eq(drives.id, w.driveId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const walletRow = async (id: string) => (await db.select().from(wallets).where(eq(wallets.id, id)))[0];
const legsOf = (walletId: string) =>
  db
    .select({ id: walletFundingLegs.id, funderKind: walletFundingLegs.funderKind, remainingCents: walletFundingLegs.remainingCents })
    .from(walletFundingLegs)
    .where(eq(walletFundingLegs.walletId, walletId))
    .orderBy(asc(walletFundingLegs.createdAt), asc(walletFundingLegs.id));

/** The c5 invariant: the wallet row mirrors its legs exactly. */
async function legInvariant(walletId: string): Promise<{ topupRemainingCents: number; legsTotal: number }> {
  const legs = await legsOf(walletId);
  return {
    topupRemainingCents: (await walletRow(walletId)).topupRemainingCents,
    legsTotal: legs.reduce((sum, leg) => sum + leg.remainingCents, 0),
  };
}

async function usageLog(userId: string): Promise<string> {
  const [log] = await db.insert(aiUsageLogs).values({ userId, provider: 'openai', model: 'openai/gpt-5.4-nano', cost: 0 }).returning({ id: aiUsageLogs.id });
  return log.id;
}

async function holdOn(userId: string, walletId: string, estCents = 50): Promise<string> {
  const [hold] = await db
    .insert(creditHolds)
    .values({ userId, walletId, estCents, expiresAt: new Date(Date.now() + 10 * 60_000) })
    .returning({ id: creditHolds.id });
  return hold.id;
}

/** Settle one call of `cents` on the drive wallet, the way a gated chat turn does. */
async function settleOnDrive(w: World, userId: string, cents: number) {
  const holdId = await holdOn(userId, w.driveWalletId);
  return consumeCredits({
    aiUsageLogId: await usageLog(userId),
    userId,
    costDollars: cents / 100,
    holdId,
    walletId: w.driveWalletId,
    markupBpsOverride: AT_COST_BPS,
  });
}

/**
 * Hold a row lock on `walletId` in its own transaction until `release()` is called. NO KEY
 * UPDATE, not UPDATE: it still queues every writer's FOR UPDATE / UPDATE of the row, but lets
 * the FK key-share of a ledger claim or hold insert through — so a settle queues at its own
 * wallet lock inside the settle transaction, not earlier at its claim.
 */
function blockWallet(walletId: string): { locked: Promise<void>; release: () => void; done: Promise<void> } {
  let release!: () => void;
  let markLocked!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const locked = new Promise<void>((resolve) => { markLocked = resolve; });
  const done = db.transaction(async (tx) => {
    await tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.id, walletId)).for('no key update');
    markLocked();
    await released;
  });
  return { locked, release, done };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a drive-wallet settle and the funding legs (real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: walletFundingLegs.id }).from(walletFundingLegs).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('wallet-settle-legs.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  beforeEach(() => {
    process.env.DEPLOYMENT_MODE = 'cloud';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    // The invariant on the wallet this test touched, before teardown deletes it — also when
    // the test failed mid-way.
    const touched = world;
    world = null;
    if (touched) {
      try {
        await expectWalletLegInvariant([touched.driveWalletId]);
      } finally {
        await teardown(touched);
      }
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('WAL-3 (partial) WAL-4 (partial) a settle keeps topupRemainingCents equal to the legs, drawing the owner leg before the later donation (FIFO)', async () => {
    if (!dbAvailable) return;
    world = await build({ ownerLegCents: 500 });
    const donated = await donateToDriveWallet({ donorUserId: world.adaId, targetWalletId: world.driveWalletId, amountCents: 300, donationId: createId() });
    expect(donated).toMatchObject({ kind: 'donated', amountCents: 300 });
    expect(await legInvariant(world.driveWalletId)).toEqual({ topupRemainingCents: 800, legsTotal: 800 });

    expect(await settleOnDrive(world, world.adaId, 150)).toBe('settled');

    expect(await legInvariant(world.driveWalletId)).toEqual({ topupRemainingCents: 650, legsTotal: 650 });
    expect((await legsOf(world.driveWalletId)).map((l) => [l.funderKind, l.remainingCents])).toEqual([
      ['owner', 350],
      ['donation', 300],
    ]);

    // Past the owner leg into the donation: 350 from the owner leg, 50 from Ada's.
    expect(await settleOnDrive(world, world.adaId, 400)).toBe('settled');

    expect(await legInvariant(world.driveWalletId)).toEqual({ topupRemainingCents: 250, legsTotal: 250 });
    expect((await legsOf(world.driveWalletId)).map((l) => [l.funderKind, l.remainingCents])).toEqual([
      ['owner', 0],
      ['donation', 250],
    ]);
    // The drive wallet's allocation is 0, so nothing was drawn from Jono's root.
    expect((await walletRow(world.jonoRootId)).monthlyRemainingCents).toBe(5_000);
  });

  it('WAL-6 (partial) a settle past every leg lands the shortfall as parent debt and leaves the legs at zero, still equal to the row', async () => {
    if (!dbAvailable) return;
    world = await build({ ownerLegCents: 100, jonoRootCents: 0 });

    expect(await settleOnDrive(world, world.jonoId, 130)).toBe('settled');

    expect(await legInvariant(world.driveWalletId)).toEqual({ topupRemainingCents: 0, legsTotal: 0 });
    // D20.2 default: the 30¢ overshoot is absorbed by the parent, never the consumer.
    expect((await walletRow(world.jonoRootId)).debtCents).toBe(30);
    expect((await walletRow(world.driveWalletId)).debtCents).toBe(0);
  });

  it('WAL-3 (partial) WAL-6 (partial) one settle draws the allocation from the parent, then the legs FIFO, then lands the overshoot on the parent', async () => {
    if (!dbAvailable) return;
    world = await build({ ownerLegCents: 500, jonoRootCents: 300, driveAllocationCents: 200 });
    const donated = await donateToDriveWallet({ donorUserId: world.adaId, targetWalletId: world.driveWalletId, amountCents: 300, donationId: createId() });
    expect(donated).toMatchObject({ kind: 'donated' });

    // 1100¢: allocation 200 (from Jono's root), owner leg 500, Ada's donation 300, then 100 uncovered.
    expect(await settleOnDrive(world, world.adaId, 1_100)).toBe('settled');

    expect(await legInvariant(world.driveWalletId)).toEqual({ topupRemainingCents: 0, legsTotal: 0 });
    const drive = await walletRow(world.driveWalletId);
    expect([drive.spentCents, drive.debtCents]).toEqual([200, 0]);
    const root = await walletRow(world.jonoRootId);
    expect([root.monthlyRemainingCents, root.debtCents]).toEqual([100, 100]);
    // The call's rows (Ada's donation pair is hers too, and not what this asserts).
    const ledger = (await db.select().from(creditLedger).where(eq(creditLedger.userId, world.adaId)))
      .filter((r) => r.entryType === 'usage' || r.entryType === 'adjustment');
    expect(ledger.map((r) => [r.entryType, r.walletId, r.appliedCents ?? r.amountCents]).sort()).toEqual([
      ['adjustment', world.jonoRootId, -100],
      ['usage', world.driveWalletId, -1_000],
    ].sort());
  });

  it('D-OW-13 a refund after a settle cannot give back cents that were already spent', async () => {
    if (!dbAvailable) return;
    world = await build({ ownerLegCents: 500 });

    expect(await settleOnDrive(world, world.jonoId, 150)).toBe('settled');

    // The owner leg holds 350 now; asking for the original 500 is refused and writes nothing.
    expect(await refundFundingLeg(world.ownerLegId, 500)).toMatchObject({ kind: 'refuse', reason: 'exceeds_remaining' });
    expect(await legInvariant(world.driveWalletId)).toEqual({ topupRemainingCents: 350, legsTotal: 350 });

    expect(await refundFundingLeg(world.ownerLegId, 350)).toMatchObject({ kind: 'refund', cents: 350, remainingCents: 0 });
    expect(await legInvariant(world.driveWalletId)).toEqual({ topupRemainingCents: 0, legsTotal: 0 });
  });

  it('WAL-5 (partial) a settle that names no wallet settles on the wallet its hold was placed on, never the personal root', async () => {
    if (!dbAvailable) return;
    world = await build({ ownerLegCents: 500 });
    const holdId = await holdOn(world.adaId, world.driveWalletId);

    const status = await consumeCredits({
      aiUsageLogId: await usageLog(world.adaId),
      userId: world.adaId,
      costDollars: 1.5,
      holdId,
      markupBpsOverride: AT_COST_BPS,
    });

    expect(status).toBe('settled');
    expect(await legInvariant(world.driveWalletId)).toEqual({ topupRemainingCents: 350, legsTotal: 350 });
    expect((await walletRow(world.adaRootId)).monthlyRemainingCents).toBe(5_000);
    expect(await db.select().from(creditHolds).where(eq(creditHolds.id, holdId))).toEqual([]);
    const [usage] = await db.select().from(creditLedger).where(eq(creditLedger.userId, world.adaId));
    expect(usage.walletId).toBe(world.driveWalletId);
  });

  it('WAL-5 (partial) a settle naming a different wallet than its hold is refused on that wallet and settles where the hold was placed', async () => {
    if (!dbAvailable) return;
    world = await build({ ownerLegCents: 500 });
    const holdId = await holdOn(world.adaId, world.driveWalletId);
    const error = vi.spyOn(loggers.ai, 'error');

    const status = await consumeCredits({
      aiUsageLogId: await usageLog(world.adaId),
      userId: world.adaId,
      costDollars: 1.5,
      holdId,
      walletId: world.adaRootId,
      markupBpsOverride: AT_COST_BPS,
    });

    expect(status).toBe('settled');
    expect((await walletRow(world.adaRootId)).monthlyRemainingCents).toBe(5_000);
    expect(await legInvariant(world.driveWalletId)).toEqual({ topupRemainingCents: 350, legsTotal: 350 });
    expect(error).toHaveBeenCalledWith('credit settle wallet does not match its hold', expect.objectContaining({
      holdId,
      holdWalletId: world.driveWalletId,
      requestedWalletId: world.adaRootId,
    }));
  });

  it('a settle and the owner donating to their own drive wallet (whose parent is the donor root) never deadlock', async () => {
    if (!dbAvailable) return;
    world = await build({ ownerLegCents: 500 });
    const w = world;

    // Hold the drive wallet so both writers queue behind it: the settle first (it locks the
    // drive wallet, then the parent), then the donation. An id-sorted donation would take
    // the parent (id "a…") while waiting on the drive wallet (id "z…") — a cycle.
    const blocker = blockWallet(w.driveWalletId);
    await blocker.locked;
    const settle = settleOnDrive(w, w.jonoId, 150);
    await pause(300);
    const donation = donateToDriveWallet({ donorUserId: w.jonoId, targetWalletId: w.driveWalletId, amountCents: 200, donationId: createId() });
    await pause(300);
    blocker.release();
    await blocker.done;

    const [settled, donated] = await Promise.allSettled([settle, donation]);
    expect(settled).toEqual({ status: 'fulfilled', value: 'settled' });
    expect(donated).toMatchObject({ status: 'fulfilled', value: { kind: 'donated', amountCents: 200 } });
    expect(await legInvariant(w.driveWalletId)).toEqual({ topupRemainingCents: 550, legsTotal: 550 });
    expect((await walletRow(w.jonoRootId)).monthlyRemainingCents).toBe(4_800);
  }, 15_000);

  it('the invariant helper refuses to pass vacuously: no wallet named, any named wallet missing, or a root named', async () => {
    if (!dbAvailable) return;
    world = await build({ ownerLegCents: 500 });
    await expect(expectWalletLegInvariant([])).rejects.toThrow(/vacuously/);
    await expect(expectWalletLegInvariant([`missing-${createId()}`])).rejects.toThrow(/not found/);
    // A mistyped id beside a real one must not shrink the check to the real one.
    await expect(expectWalletLegInvariant([`typo-${createId()}`, world.driveWalletId])).rejects.toThrow(/not found/);
    // A root wallet carries no legs: naming one checks nothing.
    await expect(expectWalletLegInvariant([world.jonoRootId])).rejects.toThrow(/root wallet/);
    await expect(expectWalletLegInvariant([world.driveWalletId])).resolves.toBeUndefined();
  });

  it('a write that breaks topupRemainingCents == SUM(legs) is refused at COMMIT by the harness trigger', async () => {
    if (!dbAvailable) return;
    world = await build({ ownerLegCents: 500 });
    const w = world;
    await installWalletLegInvariantTrigger(pool);

    // A direct top-up write that skips the legs — the class of bug P1-1 and the reconcile had.
    const write = db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ${WALLET_LEG_INVARIANT_GUC} = 'on'`));
      await tx.update(wallets).set({ topupRemainingCents: 425 }).where(eq(wallets.id, w.driveWalletId));
    });

    await expect(write).rejects.toMatchObject({ cause: { code: '23514' } });
    expect(await legInvariant(w.driveWalletId)).toEqual({ topupRemainingCents: 500, legsTotal: 500 });
  });

  it('a settle and a refund of the same wallet\'s leg never deadlock (wallet before legs, in both)', async () => {
    if (!dbAvailable) return;
    world = await build({ ownerLegCents: 500 });
    const w = world;

    // The settle queues on the drive wallet, then will lock the legs; a refund that locked
    // the leg first and the wallet second would close the cycle.
    const blocker = blockWallet(w.driveWalletId);
    await blocker.locked;
    const settle = settleOnDrive(w, w.jonoId, 150);
    await pause(300);
    const refund = refundFundingLeg(w.ownerLegId, 100);
    await pause(300);
    blocker.release();
    await blocker.done;

    const [settled, refunded] = await Promise.allSettled([settle, refund]);
    expect(settled).toEqual({ status: 'fulfilled', value: 'settled' });
    expect(refunded).toMatchObject({ status: 'fulfilled', value: { kind: 'refund', cents: 100 } });
    expect(await legInvariant(w.driveWalletId)).toEqual({ topupRemainingCents: 250, legsTotal: 250 });
  }, 15_000);
});
