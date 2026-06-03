/**
 * Impure shell for the usage breakdown: reads the user's billing period and their
 * usage-ledger rows joined to the AI usage logs, then hands them to the pure
 * `aggregateUsageBreakdown`. All decision/aggregation logic lives in the pure module
 * (`usage-breakdown.ts`); this file is just I/O.
 */

import { db } from '@pagespace/db/db';
import { and, eq, gte, lte } from '@pagespace/db/operators';
import { creditBalances, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { aggregateUsageBreakdown, type UsageBreakdown } from './usage-breakdown';

/** Fallback lookback when the user has no billing-period window yet. */
const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Spend-by-feature and spend-by-model for the user's current billing period. Spend is
 * the ledger's precise charged amount (`chargeMillicents`, post-markup) — never the
 * raw provider `cost`. The join drops usage rows whose AI log has been purged by
 * retention, which is acceptable for a "recent usage" view.
 */
export async function getUserUsageBreakdown(userId: string): Promise<UsageBreakdown> {
  const [balance] = await db
    .select({
      periodStart: creditBalances.monthlyPeriodStart,
      periodEnd: creditBalances.monthlyPeriodEnd,
    })
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .limit(1);

  const periodStart = balance?.periodStart ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS);
  const periodEnd = balance?.periodEnd ?? null;

  const rows = await db
    .select({
      source: aiUsageLogs.source,
      model: aiUsageLogs.model,
      provider: aiUsageLogs.provider,
      totalTokens: aiUsageLogs.totalTokens,
      chargeMillicents: creditLedger.chargeMillicents,
    })
    .from(creditLedger)
    .innerJoin(aiUsageLogs, eq(creditLedger.aiUsageLogId, aiUsageLogs.id))
    .where(
      and(
        eq(creditLedger.userId, userId),
        eq(creditLedger.entryType, 'usage'),
        gte(creditLedger.createdAt, periodStart),
        // Bound the window to the period end so a stale balance (period rolled but not
        // yet reset) can't leak the next period's spend into "this period". When
        // periodEnd is in the future (the normal current period) this excludes nothing.
        ...(periodEnd ? [lte(creditLedger.createdAt, periodEnd)] : []),
      ),
    );

  return aggregateUsageBreakdown(rows, {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd ? periodEnd.toISOString() : null,
  });
}
