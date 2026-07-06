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
import { pages } from '@pagespace/db/schema/core';
import { aggregateUsageBreakdown, type UsageBreakdown } from './usage-breakdown';

/** Fallback lookback when the user has no billing-period window yet. */
const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Spend-by-feature, spend-by-model, and (for source:'terminal') spend-by-machine for
 * the user's current billing period. Spend is the ledger's precise charged amount
 * (`chargeMillicents`, post-markup) — never the raw provider `cost`. The join drops
 * usage rows whose AI log has been purged by retention, which is acceptable for a
 * "recent usage" view.
 *
 * `byMachine` needs no separate drive-ownership filter: `creditLedger.userId` IS the
 * PAYER (`resolveTerminalPayerId` in terminal-payer.ts always resolves to the backing
 * page's drive owner, falling back to the acting tenant only when unresolvable), so
 * every row this query returns for `userId` is already scoped to a machine they own
 * or a run they footed the bill for directly.
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
      // Per-machine attribution (Terminal Epic 3): pageId + its active-window
      // duration are only ever set on source:'terminal' rows; the pure
      // aggregator ignores them for every other source. `pages` is left-joined
      // (not inner) so a deleted/unresolvable page still surfaces its spend,
      // under a "Untitled machine" label, rather than disappearing.
      pageId: aiUsageLogs.pageId,
      pageTitle: pages.title,
      durationMs: aiUsageLogs.duration,
    })
    .from(creditLedger)
    .innerJoin(aiUsageLogs, eq(creditLedger.aiUsageLogId, aiUsageLogs.id))
    .leftJoin(pages, eq(aiUsageLogs.pageId, pages.id))
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
