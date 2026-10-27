import 'dotenv/config';
import { getMigrationDb } from '@pagespace/db/db';
import { creditLedger } from '@pagespace/db/schema/credits';
import { wallets, isPersonalRootWallet } from '@pagespace/db/schema/wallets';
import { eq, sql } from '@pagespace/db/operators';

// One-shot ops script — runs on the unthrottled migration pool, not the
// app-throttled `db` (see getMigrationDb()'s doc comment in packages/db).
const db = getMigrationDb();

// Mirror the STRIPE_REF_ARBITER from credit-gate / credit-funding (same partial index).
const STRIPE_REF_ARBITER = {
  target: creditLedger.stripeRef,
  where: sql`${creditLedger.stripeRef} IS NOT NULL`,
} as const;

const TOLERANCE_CENTS = 10;

async function main(): Promise<void> {
  // Compute drift per user: same formula as getBalanceDriftAlerts in monitoring-queries.ts.
  const rows = await db
    .select({
      walletId: wallets.id,
      userId: wallets.userId,
      materializedSpendableCents: sql<number>`(${wallets.monthlyRemainingCents} + ${wallets.topupRemainingCents})::int`,
      grantCents: sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.entryType} IN ('monthly_grant', 'topup_purchase') THEN ${creditLedger.amountCents} ELSE 0 END), 0)::int`,
      appliedUsageCents: sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.entryType} = 'usage' THEN ABS(${creditLedger.appliedCents}) ELSE 0 END), 0)::int`,
      adjustmentCents: sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.entryType} = 'adjustment' THEN COALESCE(${creditLedger.appliedCents}, 0) ELSE 0 END), 0)::int`,
    })
    .from(wallets)
    .leftJoin(creditLedger, eq(creditLedger.walletId, wallets.id))
    .where(isPersonalRootWallet())
    .groupBy(
      wallets.id,
      wallets.userId,
      wallets.monthlyRemainingCents,
      wallets.topupRemainingCents,
    );

  let found = 0;
  let inserted = 0;
  let skipped = 0;

  for (const r of rows) {
    // Personal root wallets always have an owning user; the guard only narrows the type.
    if (!r.userId) continue;
    // Mirrors computeBalanceDrift in credit-core.ts: debtCents is NOT part of the
    // bucket equation (it is reported alongside but lives in its own column).
    const expectedSpendableCents = r.grantCents - r.appliedUsageCents + r.adjustmentCents;
    const driftCents = r.materializedSpendableCents - expectedSpendableCents;

    if (Math.abs(driftCents) <= TOLERANCE_CENTS) continue;

    found++;
    console.log(
      `  ${r.userId}: materialized=${r.materializedSpendableCents}¢, expected=${expectedSpendableCents}¢, drift=${driftCents}¢`,
    );

    const result = await db
      .insert(creditLedger)
      .values({
        userId: r.userId,
        walletId: r.walletId,
        entryType: 'adjustment',
        bucket: 'monthly',
        amountCents: driftCents,
        appliedCents: driftCents,
        stripeRef: `backfill-2026-06-07-${r.userId}`,
        consumeStatus: 'applied',
      })
      .onConflictDoNothing(STRIPE_REF_ARBITER)
      .returning({ id: creditLedger.id });

    if (result.length > 0) {
      inserted++;
      console.log(`    → inserted adjustment`);
    } else {
      skipped++;
      console.log(`    → skipped (already backfilled)`);
    }
  }

  console.log(`\nSummary: ${found} users with drift, ${inserted} entries inserted, ${skipped} skipped`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
