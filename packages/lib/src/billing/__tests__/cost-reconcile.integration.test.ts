/**
 * Cost-reconcile transaction-atomicity integration test (real Postgres).
 *
 * applyCorrection (cost-reconcile.ts) claims an `adjustment` ledger row and moves the
 * balance in ONE transaction under a row lock. The in-memory DB fake the other reconcile
 * tests use doesn't model rollback, so it can't prove the claim row is rolled back when
 * the balance UPDATE fails mid-transaction. Here we drive the real public entry point
 * (reconcileOpenRouterCosts) against real Postgres and force the balance UPDATE to throw
 * by parking debtCents at INT_MAX so the undercharge debit (debtCents + shortfall)
 * overflows int4 — a genuine mid-transaction DB error. The property: NO orphan adjustment
 * row survives and the balance is untouched.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). FAILS LOUDLY when no DB is reachable — a silent skip
 * would be a green, zero-assertion pass. Local runs without Docker opt out
 * explicitly with ALLOW_SKIP_DB_TESTS=1.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq, and, asc } from '@pagespace/db/operators';
import { creditLedger, creditHolds } from '@pagespace/db/schema/credits';
import { wallets, walletFundingLegs, personalRootWalletOf } from '@pagespace/db/schema/wallets';
import { users } from '@pagespace/db/schema/auth';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { factories } from '@pagespace/db/test/factories';
import { reconcileOpenRouterCosts, type GenerationFetcher } from '../cost-reconcile';
import { consumeCredits, refundWalletCharge } from '../credit-consume';
import { expectWalletLegInvariant } from '../../test/wallet-leg-invariant';
import { requireDb } from '@pagespace/db/test/require-db';

const INT4_MAX = 2_147_483_647;
let dbAvailable = false;


async function cleanup(userId: string): Promise<void> {
  await db.delete(creditHolds).where(eq(creditHolds.userId, userId));
  await db.delete(creditLedger).where(eq(creditLedger.userId, userId));
  await db.delete(wallets).where(eq(wallets.userId, userId));
  await db.delete(aiUsageLogs).where(eq(aiUsageLogs.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe('applyCorrection transaction atomicity (Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('cost-reconcile.integration.test.ts', error);
      dbAvailable = false;
    }
  });


  it('rolls back the claimed adjustment row when the balance UPDATE throws mid-transaction', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser({ subscriptionTier: 'pro' });
    try {
      // Empty buckets + debt parked at INT_MAX: an undercharge correction debits the extra
      // monthly-first, finds nothing, and accrues the shortfall as `debtCents + shortfall`,
      // which overflows the int4 column → the UPDATE throws inside the transaction.
      const [wallet] = await db.insert(wallets).values({
        userId: user.id,
        monthlyRemainingCents: 0,
        monthlyAllowanceCents: 0,
        topupRemainingCents: 0,
        debtCents: INT4_MAX,
        pendingMillicents: 0,
      }).returning({ id: wallets.id });

      // A billed-at-$0 OpenRouter call still pending reconcile, old enough to clear the grace
      // window, carrying a generation id. Its base `usage` ledger row must exist (reconcile
      // only corrects an already-billed call).
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
      const [log] = await db
        .insert(aiUsageLogs)
        .values({
          userId: user.id,
          provider: 'openrouter',
          model: 'e2e/stub',
          cost: 0,
          timestamp: tenMinAgo,
          reconcileStatus: 'pending',
          reconcileAttempts: 0,
          metadata: { generationIds: ['gen-rollback-1'] },
        })
        .returning({ id: aiUsageLogs.id });

      await db.insert(creditLedger).values({
        userId: user.id,
        walletId: wallet.id,
        entryType: 'usage',
        bucket: 'monthly',
        amountCents: 0,
        appliedCents: 0,
        chargeMillicents: 0,
        realCostCents: 0,
        aiUsageLogId: log.id,
      });

      // Authoritative cost $1.00 vs billed $0 → a large positive drift → undercharge debit.
      // Scoped to OUR generation id (any other pending row a shared DB might hold resolves
      // 'not_found', so this run never corrects or asserts against foreign data).
      const fetcher: GenerationFetcher = async (id) =>
        id === 'gen-rollback-1' ? { totalCost: 1.0 } : 'not_found';

      await reconcileOpenRouterCosts({ fetcher });

      // Our row's correction threw inside applyCorrection and was swallowed by the cron's
      // per-row guard, so it was never marked 'reconciled' — it stays 'pending' for a later
      // run. (Scoped to our own row, not the global corrected count, so the assertion holds
      // regardless of any other pending rows on a shared DB.)
      const [logAfter] = await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.id, log.id));
      expect(logAfter.reconcileStatus).toBe('pending');

      // ATOMICITY: the claimed adjustment ledger row was rolled back — no orphan.
      const adjustments = await db
        .select()
        .from(creditLedger)
        .where(and(eq(creditLedger.userId, user.id), eq(creditLedger.entryType, 'adjustment')));
      expect(adjustments).toHaveLength(0);

      // The balance is exactly as seeded — the failed UPDATE moved nothing.
      const [bal] = await db.select().from(wallets).where(personalRootWalletOf(user.id));
      expect(bal).toMatchObject({ debtCents: INT4_MAX, monthlyRemainingCents: 0, topupRemainingCents: 0 });

      // The base usage row (written before the transaction) is untouched.
      const usage = await db
        .select()
        .from(creditLedger)
        .where(and(eq(creditLedger.userId, user.id), eq(creditLedger.entryType, 'usage')));
      expect(usage).toHaveLength(1);
    } finally {
      await cleanup(user.id);
    }
  });

  it('WAL-5 (partial): reconciliation is keyed on wallet — a correction lands on the wallet the charge was billed to, not the owner\'s personal root', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser({ subscriptionTier: 'pro' });
    try {
      const [root] = await db.insert(wallets).values({ userId: user.id, topupRemainingCents: 700 }).returning({ id: wallets.id });
      // A drive wallet the person owns, under their personal root (WAL-2), holding its own funds.
      // Its 1000 is one owner funding leg: topupRemainingCents mirrors the legs (D-OW-13).
      const driveWallet = await db.transaction(async (tx) => {
        const [w] = await tx
          .insert(wallets)
          .values({ userId: user.id, subjectType: 'drive', subjectId: `drive_${user.id}`, parentWalletId: root.id, topupRemainingCents: 1000 })
          .returning({ id: wallets.id });
        await tx.insert(walletFundingLegs).values({ walletId: w.id, funderKind: 'owner', funderUserId: user.id, originalCents: 1000, remainingCents: 1000, nonRefundable: false });
        return w;
      });

      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
      const [log] = await db
        .insert(aiUsageLogs)
        .values({
          userId: user.id,
          provider: 'openrouter',
          model: 'e2e/stub',
          cost: 0,
          timestamp: tenMinAgo,
          reconcileStatus: 'pending',
          reconcileAttempts: 0,
          metadata: { generationIds: ['gen-wallet-keyed-1'] },
        })
        .returning({ id: aiUsageLogs.id });
      // The base charge was billed to the DRIVE wallet.
      await db.insert(creditLedger).values({
        userId: user.id,
        walletId: driveWallet.id,
        entryType: 'usage',
        bucket: 'monthly',
        amountCents: 0,
        appliedCents: 0,
        chargeMillicents: 0,
        realCostCents: 0,
        aiUsageLogId: log.id,
      });

      // Authoritative $1.00 vs billed $0 → an undercharge debit of the marked-up cost.
      const fetcher: GenerationFetcher = async (id) => (id === 'gen-wallet-keyed-1' ? { totalCost: 1.0 } : 'not_found');
      await reconcileOpenRouterCosts({ fetcher });

      const [logAfter] = await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.id, log.id));
      expect(logAfter.reconcileStatus).toBe('reconciled');
      const [adjustment] = await db
        .select()
        .from(creditLedger)
        .where(and(eq(creditLedger.userId, user.id), eq(creditLedger.entryType, 'adjustment')));
      expect(adjustment.walletId).toBe(driveWallet.id);

      const [driveAfter] = await db.select().from(wallets).where(eq(wallets.id, driveWallet.id));
      const [rootAfter] = await db.select().from(wallets).where(eq(wallets.id, root.id));
      // The drive wallet paid exactly what the adjustment row says left it; the root is untouched.
      expect(driveAfter.topupRemainingCents).toBe(1000 + (adjustment.appliedCents ?? 0));
      expect(adjustment.appliedCents).toBeLessThan(0);
      expect(rootAfter.topupRemainingCents).toBe(700);
      await expectWalletLegInvariant([driveWallet.id]);
    } finally {
      await db.delete(creditLedger).where(eq(creditLedger.userId, user.id));
      await db.delete(wallets).where(and(eq(wallets.userId, user.id), eq(wallets.subjectType, 'drive')));
      await cleanup(user.id);
    }
  });

  describe('a correction on a drive wallet keeps its funding legs in step (D-OW-13)', () => {
    interface DriveWorld { userId: string; rootId: string; driveId: string; ownerLegId: string; donationLegId: string }

    /**
     * A person's root wallet with a drive wallet under it: an owner leg (older), then a
     * donation leg (newer), written in ONE transaction so the row always mirrors its legs.
     */
    async function driveWorld(input: { rootMonthlyCents: number; allocationCents: number; ownerLegCents: number; donationLegCents: number }): Promise<DriveWorld> {
      const user = await factories.createUser({ subscriptionTier: 'pro' });
      return db.transaction(async (tx) => {
        const [root] = await tx.insert(wallets).values({ userId: user.id, monthlyRemainingCents: input.rootMonthlyCents }).returning({ id: wallets.id });
        const [drive] = await tx.insert(wallets).values({
          userId: user.id,
          subjectType: 'drive',
          subjectId: `drive_${user.id}`,
          parentWalletId: root.id,
          monthlyAllowanceCents: input.allocationCents,
          topupRemainingCents: input.ownerLegCents + input.donationLegCents,
        }).returning({ id: wallets.id });
        const [ownerLeg] = await tx.insert(walletFundingLegs).values({
          walletId: drive.id, funderKind: 'owner', funderUserId: user.id,
          originalCents: input.ownerLegCents, remainingCents: input.ownerLegCents, nonRefundable: false,
          createdAt: new Date(Date.now() - 120_000),
        }).returning({ id: walletFundingLegs.id });
        const [donationLeg] = await tx.insert(walletFundingLegs).values({
          walletId: drive.id, funderKind: 'donation', funderUserId: user.id,
          originalCents: input.donationLegCents, remainingCents: input.donationLegCents, nonRefundable: true,
          createdAt: new Date(Date.now() - 60_000),
        }).returning({ id: walletFundingLegs.id });
        return { userId: user.id, rootId: root.id, driveId: drive.id, ownerLegId: ownerLeg.id, donationLegId: donationLeg.id };
      });
    }

    /** The invariant on the drive wallet this test touched, then its teardown — even if the test failed mid-way. */
    async function dropWorld(w: DriveWorld): Promise<void> {
      try {
        await expectWalletLegInvariant([w.driveId]);
      } finally {
        await deleteWorld(w);
      }
    }

    async function deleteWorld(w: DriveWorld): Promise<void> {
      await db.delete(creditLedger).where(eq(creditLedger.userId, w.userId));
      await db.delete(wallets).where(eq(wallets.id, w.driveId));
      await cleanup(w.userId);
    }

    /**
     * Bill one $1.00 call (150¢ at the markup) to the drive wallet, then reconcile it at
     * `authoritativeDollars`. `between` runs after the settle and before the reconcile (to
     * tamper with, or strip, the call's draw record). Returns the usage row id.
     */
    async function chargeThenReconcile(
      w: DriveWorld,
      genId: string,
      authoritativeDollars: number,
      between?: (aiUsageLogId: string) => Promise<void>,
      billedDollars = 1.0,
    ): Promise<string> {
      const [log] = await db.insert(aiUsageLogs).values({
        userId: w.userId, provider: 'openrouter', model: 'e2e/stub', cost: billedDollars,
        timestamp: new Date(Date.now() - 10 * 60 * 1000),
        reconcileStatus: 'pending', reconcileAttempts: 0,
        metadata: { generationIds: [genId] },
      }).returning({ id: aiUsageLogs.id });
      expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.userId, costDollars: billedDollars, walletId: w.driveId })).toBe('settled');
      if (between) await between(log.id);
      const fetcher: GenerationFetcher = async (id) => (id === genId ? { totalCost: authoritativeDollars } : 'not_found');
      await reconcileOpenRouterCosts({ fetcher });
      const [after] = await db.select({ status: aiUsageLogs.reconcileStatus }).from(aiUsageLogs).where(eq(aiUsageLogs.id, log.id));
      expect(after.status).toBe('reconciled');
      return log.id;
    }

    /** Replace the call's walletDraws record, keeping the rest of its metadata. */
    const setDraws = (walletDraws: unknown) => async (aiUsageLogId: string) => {
      const [row] = await db.select({ metadata: aiUsageLogs.metadata }).from(aiUsageLogs).where(eq(aiUsageLogs.id, aiUsageLogId));
      await db.update(aiUsageLogs).set({ metadata: { ...(row.metadata as Record<string, unknown>), walletDraws } }).where(eq(aiUsageLogs.id, aiUsageLogId));
    };
    const drawsOf = async (aiUsageLogId: string) =>
      ((await db.select({ metadata: aiUsageLogs.metadata }).from(aiUsageLogs).where(eq(aiUsageLogs.id, aiUsageLogId)))[0].metadata as Record<string, unknown>).walletDraws;

    const legs = async (walletId: string) =>
      (await db.select({ id: walletFundingLegs.id, remainingCents: walletFundingLegs.remainingCents })
        .from(walletFundingLegs).where(eq(walletFundingLegs.walletId, walletId))
        .orderBy(asc(walletFundingLegs.createdAt), asc(walletFundingLegs.id))).map((l) => l.remainingCents);
    const wallet = async (id: string) => (await db.select().from(wallets).where(eq(wallets.id, id)))[0];

    it('an undercharge draws the extra through the legs (FIFO) and the row still equals the legs', async () => {
      if (!dbAvailable) return;
      const w = await driveWorld({ rootMonthlyCents: 0, allocationCents: 0, ownerLegCents: 100, donationLegCents: 300 });
      try {
        // 150¢: owner leg 100, then 50 of the donation. Authoritative $1.20 → +30¢, from the donation.
        await chargeThenReconcile(w, `gen-under-${w.userId}`, 1.2);
        expect(await legs(w.driveId)).toEqual([0, 220]);
        expect((await wallet(w.driveId)).topupRemainingCents).toBe(220);
      } finally {
        await dropWorld(w);
      }
    });

    it('an overcharge returns to the legs this call drew from, newest-drawn first, and never lifts a donation leg past what it held before the call', async () => {
      if (!dbAvailable) return;
      const w = await driveWorld({ rootMonthlyCents: 0, allocationCents: 0, ownerLegCents: 100, donationLegCents: 300 });
      try {
        // 150¢ drew owner 100 then donation 50. Authoritative $0.40 → 60¢: refund 90¢ —
        // 50 back to the donation leg (all this call took from it), then 40 to the owner leg.
        await chargeThenReconcile(w, `gen-over-${w.userId}`, 0.4);
        expect(await legs(w.driveId)).toEqual([40, 300]);
        expect((await wallet(w.driveId)).topupRemainingCents).toBe(340);
        const [adjustment] = await db.select().from(creditLedger)
          .where(and(eq(creditLedger.userId, w.userId), eq(creditLedger.entryType, 'adjustment')));
        expect(adjustment.appliedCents).toBe(90);
      } finally {
        await dropWorld(w);
      }
    });

    it('an overcharge past the legs this call drew gives back its allocation: the drive wallet spent less, the parent is credited', async () => {
      if (!dbAvailable) return;
      const w = await driveWorld({ rootMonthlyCents: 5_000, allocationCents: 100, ownerLegCents: 100, donationLegCents: 50 });
      try {
        // 150¢: 100 allocation from the root, then 50 from the owner leg. Refund 90¢: the
        // owner leg's 50 first, then 40 of the allocation.
        await chargeThenReconcile(w, `gen-alloc-${w.userId}`, 0.4);
        expect(await legs(w.driveId)).toEqual([100, 50]);
        const drive = await wallet(w.driveId);
        expect([drive.topupRemainingCents, drive.spentCents]).toEqual([150, 60]);
        const root = await wallet(w.rootId);
        expect([root.monthlyRemainingCents, root.topupRemainingCents, root.debtCents]).toEqual([4_900, 40, 0]);
      } finally {
        await dropWorld(w);
      }
    });

    it('an overcharge first unwinds the debt this call landed on the parent, then the legs', async () => {
      if (!dbAvailable) return;
      const w = await driveWorld({ rootMonthlyCents: 0, allocationCents: 0, ownerLegCents: 60, donationLegCents: 40 });
      try {
        // 150¢: owner 60, donation 40, then 50 uncovered → the parent's debt (D20.2).
        // Refund 90¢: the 50 of debt, then 40 back to the donation leg (all it gave).
        await chargeThenReconcile(w, `gen-debt-${w.userId}`, 0.4);
        expect((await wallet(w.rootId)).debtCents).toBe(0);
        expect(await legs(w.driveId)).toEqual([0, 40]);
        expect((await wallet(w.driveId)).topupRemainingCents).toBe(40);
      } finally {
        await dropWorld(w);
      }
    });

    it('a refund that exceeds the record by rounding still goes back through the record — only the excess cent reaches the parent', async () => {
      if (!dbAvailable) return;
      const w = await driveWorld({ rootMonthlyCents: 0, allocationCents: 0, ownerLegCents: 1, donationLegCents: 1_000 });
      try {
        // $0.996 at 1.5× is 149.4¢: the settle draws 149 whole cents (owner 1, donation 148)
        // and carries 0.4¢. Reconciled to $0, the refund rounds to 150 — 1¢ over the record.
        await chargeThenReconcile(w, `gen-round-${w.userId}`, 0, undefined, 0.996);
        // Ada's 148 go back to her leg (not into the owner's personal balance); the rounding cent to the parent.
        expect(await legs(w.driveId)).toEqual([1, 1_000]);
        expect((await wallet(w.driveId)).topupRemainingCents).toBe(1_001);
        expect((await wallet(w.rootId)).topupRemainingCents).toBe(1);
      } finally {
        await dropWorld(w);
      }
    });

    it('the settle records the call\'s draws on its usage row, and the refund leaves what is left of them', async () => {
      if (!dbAvailable) return;
      const w = await driveWorld({ rootMonthlyCents: 0, allocationCents: 0, ownerLegCents: 100, donationLegCents: 300 });
      try {
        let recorded: unknown;
        const logId = await chargeThenReconcile(w, `gen-rec-${w.userId}`, 0.4, async (id) => { recorded = await drawsOf(id); });
        expect(recorded).toEqual({
          walletId: w.driveId, totalCents: 150, allocationCents: 0, debtCents: 0, debtWalletId: null,
          legs: [{ legId: w.ownerLegId, cents: 100 }, { legId: w.donationLegId, cents: 50 }],
        });
        // 90¢ returned: the donation's 50, then 40 of the owner's 100.
        expect(await drawsOf(logId)).toMatchObject({ totalCents: 60, legs: [{ legId: w.ownerLegId, cents: 60 }, { legId: w.donationLegId, cents: 0 }] });
      } finally {
        await dropWorld(w);
      }
    });

    it('a charge with NO draw record (settled before the record existed) refunds to the parent, debt first — legs untouched, invariant intact', async () => {
      if (!dbAvailable) return;
      const w = await driveWorld({ rootMonthlyCents: 0, allocationCents: 0, ownerLegCents: 100, donationLegCents: 300 });
      try {
        await chargeThenReconcile(w, `gen-legacy-${w.userId}`, 0.4, setDraws(undefined));
        expect(await legs(w.driveId)).toEqual([0, 250]);
        expect((await wallet(w.driveId)).topupRemainingCents).toBe(250);
        const root = await wallet(w.rootId);
        expect([root.debtCents, root.topupRemainingCents]).toEqual([0, 90]);
      } finally {
        await dropWorld(w);
      }
    });

    // Every shape the untrusted jsonb record can take that must NOT be believed. Each one
    // falls back to the legacy parent path: no throw, no guessed leg, legs unchanged.
    const MALFORMED: [string, (w: DriveWorld) => unknown][] = [
      ['a string', () => 'not a record'],
      ['legs of the wrong type', (w) => ({ walletId: w.driveId, totalCents: 150, allocationCents: 0, debtCents: 0, debtWalletId: null, legs: 'owner' })],
      ['a leg with fractional cents', (w) => ({ walletId: w.driveId, totalCents: 150, allocationCents: 0, debtCents: 0, debtWalletId: null, legs: [{ legId: w.ownerLegId, cents: 149.5 }, { legId: w.donationLegId, cents: 0.5 }] })],
      ['parts that disagree with the total', (w) => ({ walletId: w.driveId, totalCents: 999, allocationCents: 0, debtCents: 0, debtWalletId: null, legs: [{ legId: w.ownerLegId, cents: 100 }, { legId: w.donationLegId, cents: 50 }] })],
      ['another wallet\'s record', (w) => ({ walletId: w.rootId, totalCents: 150, allocationCents: 0, debtCents: 0, debtWalletId: null, legs: [{ legId: w.ownerLegId, cents: 150 }] })],
      ['a leg that no longer exists', (w) => ({ walletId: w.driveId, totalCents: 150, allocationCents: 0, debtCents: 0, debtWalletId: null, legs: [{ legId: 'leg-gone', cents: 150 }] })],
      // The donation leg took 50; a record claiming 150 from it would lift it past its
      // originalCents (300) — refused whole, the donation leg stays at what it holds.
      ['a donation leg claimed beyond what it gave', (w) => ({ walletId: w.driveId, totalCents: 150, allocationCents: 0, debtCents: 0, debtWalletId: null, legs: [{ legId: w.donationLegId, cents: 150 }] })],
    ];
    for (const [label, record] of MALFORMED) {
      it(`an untrusted draw record (${label}) takes the parent path: no throw, legs untouched, invariant intact`, async () => {
        if (!dbAvailable) return;
        const w = await driveWorld({ rootMonthlyCents: 0, allocationCents: 0, ownerLegCents: 100, donationLegCents: 300 });
        try {
          await chargeThenReconcile(w, `gen-bad-${w.userId}`, 0.4, setDraws(record(w)));
          expect(await legs(w.driveId)).toEqual([0, 250]);
          expect((await wallet(w.driveId)).topupRemainingCents).toBe(250);
          expect((await wallet(w.rootId)).topupRemainingCents).toBe(90);
        } finally {
          await dropWorld(w);
        }
      });
    }

    it('a refund whose usage row is GONE (pruned) takes the parent path with the invariant intact', async () => {
      if (!dbAvailable) return;
      const w = await driveWorld({ rootMonthlyCents: 0, allocationCents: 0, ownerLegCents: 100, donationLegCents: 300 });
      try {
        const [log] = await db.insert(aiUsageLogs).values({ userId: w.userId, provider: 'openrouter', model: 'e2e/stub', cost: 1.0 }).returning({ id: aiUsageLogs.id });
        expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.userId, costDollars: 1.0, walletId: w.driveId })).toBe('settled');
        await db.delete(aiUsageLogs).where(eq(aiUsageLogs.id, log.id));

        const credited = await db.transaction((tx) => refundWalletCharge(tx, w.driveId, 90, log.id));

        expect(credited).toBe(90);
        expect(await legs(w.driveId)).toEqual([0, 250]);
        expect((await wallet(w.driveId)).topupRemainingCents).toBe(250);
        expect((await wallet(w.rootId)).topupRemainingCents).toBe(90);
      } finally {
        await dropWorld(w);
      }
    });

    it('the same correction applied twice returns its cents once — the correction\'s claim is the key', async () => {
      if (!dbAvailable) return;
      const w = await driveWorld({ rootMonthlyCents: 0, allocationCents: 0, ownerLegCents: 100, donationLegCents: 300 });
      try {
        const genId = `gen-twice-${w.userId}`;
        const logId = await chargeThenReconcile(w, genId, 0.4);
        expect(await legs(w.driveId)).toEqual([40, 300]);

        // Force the row back to pending and reconcile the same generation again.
        await db.update(aiUsageLogs).set({ reconcileStatus: 'pending', reconciledAt: null }).where(eq(aiUsageLogs.id, logId));
        await reconcileOpenRouterCosts({ fetcher: async (id) => (id === genId ? { totalCost: 0.4 } : 'not_found') });

        expect(await legs(w.driveId)).toEqual([40, 300]);
        expect((await wallet(w.driveId)).topupRemainingCents).toBe(340);
        expect((await wallet(w.rootId)).topupRemainingCents).toBe(0);
        const corrections = await db.select().from(creditLedger)
          .where(and(eq(creditLedger.userId, w.userId), eq(creditLedger.entryType, 'adjustment')));
        expect(corrections).toHaveLength(1);
      } finally {
        await dropWorld(w);
      }
    });
  });
});
