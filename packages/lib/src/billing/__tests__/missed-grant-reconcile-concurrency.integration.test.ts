/**
 * Missed-grant reconcile concurrency (real Postgres).
 *
 * Drives the REAL reconcileMissedGrants against a real database — no fake DB. The
 * property under test is the one the in-memory fake cannot prove: two overlapping
 * reconcile runs that both SELECTed the same 'missed_grant' row must grant it exactly
 * once. The claim is `UPDATE credit_ledger … WHERE id = $1 AND entryType = 'missed_grant'`;
 * under READ COMMITTED the second UPDATE blocks on the first's row lock, then
 * re-evaluates its WHERE against the committed row version. Keyed on the id alone it
 * still matches (the id never changes) and rolls the allowance in a SECOND time.
 *
 * Determinism: a blocker transaction holds `FOR UPDATE` on the row while both runs
 * start. Their SELECTs are not blocked, so both see the row; both then queue on the
 * row lock in their claim UPDATE. We wait until exactly two claim UPDATEs are blocked
 * behind THE BLOCKER'S OWN pid — the first directly, the second queued behind the
 * first's tuple lock (pg_blocking_pids, so lock waits from other suites sharing the
 * database cannot satisfy it) — release the blocker, and let them race for real.
 *
 * Requires DATABASE_URL → a migrated Postgres. FAILS LOUDLY when none is reachable
 * (see @pagespace/db/test/require-db); ALLOW_SKIP_DB_TESTS=1 is the only opt-out.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { creditBalances, creditLedger } from '@pagespace/db/schema/credits';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { users } from '@pagespace/db/schema/auth';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { createId } from '@paralleldrive/cuid2';
import { reconcileMissedGrants } from '../missed-grant-reconcile';
import { allowanceCentsForPaidCents } from '../money-model';

let dbAvailable = false;

async function claimUpdatesBlockedBy(blockerPid: number): Promise<number> {
  const res = await db.execute(sql`
    select count(*)::int as n from pg_stat_activity a
    where a.query ilike 'update "credit_ledger"%'
      and (
        ${blockerPid} = any(pg_blocking_pids(a.pid))
        or exists (
          select 1 from pg_stat_activity b
          where b.pid = any(pg_blocking_pids(a.pid))
            and ${blockerPid} = any(pg_blocking_pids(b.pid))
        )
      )
  `);
  return Number((res.rows[0] as { n: number }).n);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe('reconcileMissedGrants concurrency (Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(creditLedger).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('missed-grant-reconcile-concurrency.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  it('MON-2 WAL-5 two overlapping reconcile runs on the same missed_grant row grant it exactly once', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser({ subscriptionTier: 'pro' });
    const priceId = `price_mgr_pro_${createId()}`;
    // Only this test's price maps to a tier, so rows other suites left behind stay untouched.
    const priceTier = (p: string) => (p === priceId ? ('pro' as const) : ('free' as const));
    const ledgerId = createId();
    const paidCents = 1500;
    const allowance = allowanceCentsForPaidCents(paidCents, 'pro');
    try {
      const now = new Date();
      await db.insert(subscriptions).values({
        userId: user.id,
        stripeSubscriptionId: `sub_${createId()}`,
        stripePriceId: priceId,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
      });
      await db.insert(creditLedger).values({
        id: ledgerId,
        userId: user.id,
        entryType: 'missed_grant',
        bucket: 'monthly',
        amountCents: 0,
        paidCents,
        stripeRef: `in_${createId()}`,
        consumeStatus: 'applied',
      });

      let runs: Promise<Awaited<ReturnType<typeof reconcileMissedGrants>>[]> | undefined;
      try {
        await db.transaction(async (blocker) => {
          await blocker.select({ id: creditLedger.id }).from(creditLedger).where(eq(creditLedger.id, ledgerId)).for('update');
          const pidRes = await blocker.execute(sql`select pg_backend_pid()::int as pid`);
          const blockerPid = Number((pidRes.rows[0] as { pid: number }).pid);
          runs = Promise.all([reconcileMissedGrants({ priceTier }), reconcileMissedGrants({ priceTier })]);
          await waitFor(async () => (await claimUpdatesBlockedBy(blockerPid)) === 2, 10_000);
        });
      } finally {
        // Never leave the runs dangling past cleanup, even when waitFor times out.
        await runs?.catch(() => undefined);
      }
      const results = await runs!;

      expect(results.reduce((n, r) => n + r.reconciled, 0)).toBe(1);
      expect(results.reduce((n, r) => n + r.failed, 0)).toBe(0);

      const [balance] = await db.select().from(creditBalances).where(eq(creditBalances.userId, user.id));
      expect(balance.monthlyRemainingCents).toBe(allowance); // not 2 × allowance

      const [row] = await db.select().from(creditLedger).where(eq(creditLedger.id, ledgerId));
      expect(row).toMatchObject({ entryType: 'monthly_grant', amountCents: allowance });
    } finally {
      await db.delete(creditLedger).where(eq(creditLedger.userId, user.id));
      await db.delete(creditBalances).where(eq(creditBalances.userId, user.id));
      await db.delete(subscriptions).where(eq(subscriptions.userId, user.id));
      await db.delete(users).where(eq(users.id, user.id));
    }
  }, 30_000);
});
