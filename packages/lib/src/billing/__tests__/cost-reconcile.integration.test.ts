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
 * (scripts/test-with-db.sh, port 5433). Skipped when no DB is reachable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { creditBalances, creditLedger, creditHolds } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { factories } from '@pagespace/db/test/factories';
import { reconcileOpenRouterCosts, type GenerationFetcher } from '../cost-reconcile';

const INT4_MAX = 2_147_483_647;
let dbAvailable = false;

const originalEnforcement = process.env.CREDITS_ENFORCEMENT_ENABLED;

async function cleanup(userId: string): Promise<void> {
  await db.delete(creditHolds).where(eq(creditHolds.userId, userId));
  await db.delete(creditLedger).where(eq(creditLedger.userId, userId));
  await db.delete(creditBalances).where(eq(creditBalances.userId, userId));
  await db.delete(aiUsageLogs).where(eq(aiUsageLogs.userId, userId));
}

describe('applyCorrection transaction atomicity (Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(creditBalances).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  beforeEach(() => {
    // isBillingEnabled() must be true (cloud default) for reconcile to do anything; the
    // reconcile path itself is independent of the enforcement flag, but keep it explicit.
    process.env.CREDITS_ENFORCEMENT_ENABLED = 'true';
  });

  afterAll(() => {
    if (originalEnforcement === undefined) delete process.env.CREDITS_ENFORCEMENT_ENABLED;
    else process.env.CREDITS_ENFORCEMENT_ENABLED = originalEnforcement;
  });

  it('rolls back the claimed adjustment row when the balance UPDATE throws mid-transaction', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser({ subscriptionTier: 'pro' });
    try {
      // Empty buckets + debt parked at INT_MAX: an undercharge correction debits the extra
      // monthly-first, finds nothing, and accrues the shortfall as `debtCents + shortfall`,
      // which overflows the int4 column → the UPDATE throws inside the transaction.
      await db.insert(creditBalances).values({
        userId: user.id,
        monthlyRemainingCents: 0,
        monthlyAllowanceCents: 0,
        topupRemainingCents: 0,
        debtCents: INT4_MAX,
        pendingMillicents: 0,
      });

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
      const [bal] = await db.select().from(creditBalances).where(eq(creditBalances.userId, user.id));
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
});
