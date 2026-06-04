/**
 * Monitoring account-alerts queries — real Postgres integration tests.
 *
 * Real-DB sibling of account-alerts-queries.test.ts (which mocks db.select and feeds
 * canned rows — it proves the JS sort/filter/map, but the actual SQL never runs). The
 * money risk in getBalanceDriftAlerts / getNegativeMarginAccounts lives in their SQL:
 * the per-entryType CASE WHEN aggregates, the COALESCE(...)::int casts, and the
 * `HAVING chargedSum < realCostSum * (1 + bps)`. This file inserts real credit_ledger /
 * credit_balances / ai_usage_logs rows and runs the ACTUAL queries so that SQL is
 * exercised, then asserts the flagged accounts + numbers, and that the SQL HAVING and the
 * JS isNegativeMargin re-check agree on real data.
 *
 * SAFETY: these queries aggregate across ALL users (no user filter), but this test must
 * never delete rows it did not create — a developer/CI job with a real or staging
 * DATABASE_URL would otherwise have its billing tables silently wiped. So cleanup is
 * scoped to the users this file creates, and every assertion filters the (global) query
 * result down to those users, which also makes the test robust to pre-existing rows
 * (a large `limit` keeps the seeded users in the result regardless of other data).
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). Skipped when no DB is reachable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { creditLedger, creditBalances, creditHolds } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { factories } from '@pagespace/db/test/factories';
import { isNegativeMargin } from '@pagespace/lib/billing/credit-core';
import { getBalanceDriftAlerts, getNegativeMarginAccounts } from '../monitoring-queries';

// Large enough that the seeded users always survive the queries' ORDER BY ... LIMIT even
// if the target DB already holds unrelated billing rows.
const BIG_LIMIT = 100_000;

let dbAvailable = false;
// Every user this file creates — the ONLY rows cleanup is allowed to delete.
const createdUserIds: string[] = [];

async function mkUser(overrides?: Parameters<typeof factories.createUser>[0]) {
  const user = await factories.createUser(overrides);
  createdUserIds.push(user.id);
  return user;
}

/** Delete only the rows belonging to users this file created (FK-safe order). */
async function cleanupCreated(): Promise<void> {
  for (const id of createdUserIds) {
    await db.delete(creditHolds).where(eq(creditHolds.userId, id));
    await db.delete(creditLedger).where(eq(creditLedger.userId, id));
    await db.delete(creditBalances).where(eq(creditBalances.userId, id));
    await db.delete(aiUsageLogs).where(eq(aiUsageLogs.userId, id));
  }
  createdUserIds.length = 0;
}

type LedgerRow = typeof creditLedger.$inferInsert;
async function insertLedger(row: LedgerRow): Promise<void> {
  await db.insert(creditLedger).values(row);
}

describe('account-alerts monitoring queries (Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(creditBalances).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  beforeEach(async () => {
    if (dbAvailable) await cleanupCreated();
  });

  afterAll(async () => {
    if (dbAvailable) await cleanupCreated();
  });

  describe('getBalanceDriftAlerts', () => {
    it('flags exactly the divergent accounts, worst |drift| first, with correct numbers', async () => {
      if (!dbAvailable) return;
      // d_ok: grant 1000 − usage 300 = expected 700; materialized 700 → drift 0 (within 10¢).
      const ok = await mkUser();
      await db.insert(creditBalances).values({
        userId: ok.id, monthlyRemainingCents: 700, monthlyAllowanceCents: 1000, topupRemainingCents: 0,
      });
      await insertLedger({ userId: ok.id, entryType: 'monthly_grant', bucket: 'monthly', amountCents: 1000 });
      await insertLedger({ userId: ok.id, entryType: 'usage', bucket: 'monthly', amountCents: -300, appliedCents: -300 });

      // d_flag: expected 700; materialized 800 → drift +100.
      const flag = await mkUser();
      await db.insert(creditBalances).values({
        userId: flag.id, monthlyRemainingCents: 800, monthlyAllowanceCents: 1000, topupRemainingCents: 0,
      });
      await insertLedger({ userId: flag.id, entryType: 'monthly_grant', bucket: 'monthly', amountCents: 1000 });
      await insertLedger({ userId: flag.id, entryType: 'usage', bucket: 'monthly', amountCents: -300, appliedCents: -300 });

      // d_buckets: grant 500(monthly)+1000(topup)=1500 − usage 200 + adjustment 50 = expected 1350;
      // materialized 1000+300=1300 → drift −50. Exercises every entryType bucket of the CASE WHENs.
      const buckets = await mkUser();
      await db.insert(creditBalances).values({
        userId: buckets.id, monthlyRemainingCents: 1000, monthlyAllowanceCents: 1500, topupRemainingCents: 300,
      });
      await insertLedger({ userId: buckets.id, entryType: 'monthly_grant', bucket: 'monthly', amountCents: 500 });
      await insertLedger({ userId: buckets.id, entryType: 'topup_purchase', bucket: 'topup', amountCents: 1000 });
      await insertLedger({ userId: buckets.id, entryType: 'usage', bucket: 'monthly', amountCents: -200, appliedCents: -200 });
      await insertLedger({ userId: buckets.id, entryType: 'adjustment', bucket: 'monthly', amountCents: 50, appliedCents: 50 });

      const mine = new Set(createdUserIds);
      const rows = await getBalanceDriftAlerts(undefined, BIG_LIMIT); // default 10¢ tolerance
      const mineRows = rows.filter((r) => mine.has(r.userId));

      expect(mineRows.map((r) => r.userId)).toEqual([flag.id, buckets.id]); // sorted by |drift| desc
      expect(mineRows[0]).toMatchObject({
        userId: flag.id, expectedSpendableCents: 700, materializedSpendableCents: 800, driftCents: 100,
      });
      expect(mineRows[1]).toMatchObject({
        userId: buckets.id, expectedSpendableCents: 1350, materializedSpendableCents: 1300, driftCents: -50,
      });
      // The within-tolerance account is not flagged at all.
      expect(rows.some((r) => r.userId === ok.id)).toBe(false);
    });

    it('does not flag an account within tolerance', async () => {
      if (!dbAvailable) return;
      const u = await mkUser();
      // expected 700, materialized 705 → drift 5 ≤ 10¢ tolerance.
      await db.insert(creditBalances).values({
        userId: u.id, monthlyRemainingCents: 705, monthlyAllowanceCents: 1000, topupRemainingCents: 0,
      });
      await insertLedger({ userId: u.id, entryType: 'monthly_grant', bucket: 'monthly', amountCents: 1000 });
      await insertLedger({ userId: u.id, entryType: 'usage', bucket: 'monthly', amountCents: -300, appliedCents: -300 });

      const rows = await getBalanceDriftAlerts(undefined, BIG_LIMIT);
      expect(rows.some((r) => r.userId === u.id)).toBe(false);
    });
  });

  describe('getNegativeMarginAccounts', () => {
    /** Seed one usage ledger row; optionally a linked ai_usage_logs row carrying real cost. */
    async function seedUsage(opts: {
      realCostDollars: number | null; // null → no ai_usage_logs row (purge case → falls back to realCostCents)
      realCostCentsFallback: number; // creditLedger.realCostCents (used when cost is NULL)
      chargedCents: number;
    }): Promise<string> {
      const user = await mkUser();
      let aiUsageLogId: string | undefined;
      if (opts.realCostDollars !== null) {
        const [log] = await db
          .insert(aiUsageLogs)
          .values({ userId: user.id, provider: 'openrouter', model: 'e2e/stub', cost: opts.realCostDollars })
          .returning({ id: aiUsageLogs.id });
        aiUsageLogId = log.id;
      }
      await insertLedger({
        userId: user.id,
        entryType: 'usage',
        bucket: 'monthly',
        amountCents: -opts.chargedCents,
        appliedCents: -opts.chargedCents,
        chargeMillicents: opts.chargedCents * 1000,
        realCostCents: opts.realCostCentsFallback,
        aiUsageLogId,
      });
      return user.id;
    }

    it('keeps exactly the accounts whose charged credits fail to cover real cost; SQL HAVING agrees with isNegativeMargin', async () => {
      if (!dbAvailable) return;
      // Each tuple: [real cents, charged cents]. Build users covering every branch.
      const neg = await seedUsage({ realCostDollars: 1.0, realCostCentsFallback: 100, chargedCents: 90 }); // -10 → flag
      const pos = await seedUsage({ realCostDollars: 1.0, realCostCentsFallback: 100, chargedCents: 150 }); // +50 → no
      const even = await seedUsage({ realCostDollars: 1.0, realCostCentsFallback: 100, chargedCents: 100 }); // 0 → no (100<100 false)
      const purged = await seedUsage({ realCostDollars: null, realCostCentsFallback: 100, chargedCents: 80 }); // -20 via ELSE branch → flag
      const zero = await seedUsage({ realCostDollars: 0.0, realCostCentsFallback: 0, chargedCents: 0 }); // real 0 → excluded

      const cases: Record<string, { real: number; charged: number }> = {
        [neg]: { real: 100, charged: 90 },
        [pos]: { real: 100, charged: 150 },
        [even]: { real: 100, charged: 100 },
        [purged]: { real: 100, charged: 80 },
        [zero]: { real: 0, charged: 0 },
      };

      const mine = new Set(createdUserIds);
      const rows = await getNegativeMarginAccounts(undefined, undefined, 0, BIG_LIMIT);
      const mineRows = rows.filter((r) => mine.has(r.userId));

      // The query's flagged set (restricted to this test's users) must equal what the pure
      // helper would flag on the same data.
      const jsFlagged = Object.entries(cases)
        .filter(([, c]) => isNegativeMargin(c.real, c.charged, 0))
        .map(([id]) => id)
        .sort();
      expect([...mineRows.map((r) => r.userId)].sort()).toEqual(jsFlagged);
      expect(jsFlagged).toEqual([neg, purged].sort());

      // Worst (most negative) margin first, and the numbers are right.
      expect(mineRows.map((r) => r.userId)).toEqual([purged, neg]); // -20 before -10
      expect(mineRows.find((r) => r.userId === neg)).toMatchObject({ realCostCents: 100, chargedCents: 90, marginCents: -10, marginPct: -10 });
      expect(mineRows.find((r) => r.userId === purged)).toMatchObject({ realCostCents: 100, chargedCents: 80, marginCents: -20 });
    });

    it('a margin floor demands headroom: a thin-but-positive account is flagged at a positive floor', async () => {
      if (!dbAvailable) return;
      // charged 105 vs real 100 = +5% margin. Clears floor 0, fails a 10% (1000bps) floor.
      const thin = await seedUsage({ realCostDollars: 1.0, realCostCentsFallback: 100, chargedCents: 105 });

      const atFloor0 = await getNegativeMarginAccounts(undefined, undefined, 0, BIG_LIMIT);
      expect(atFloor0.some((r) => r.userId === thin)).toBe(false);

      const atFloor1000 = await getNegativeMarginAccounts(undefined, undefined, 1000, BIG_LIMIT);
      expect(atFloor1000.some((r) => r.userId === thin)).toBe(true);

      // SQL HAVING and the JS re-check agree at this floor too.
      expect(isNegativeMargin(100, 105, 1000)).toBe(true);
    });
  });
});
