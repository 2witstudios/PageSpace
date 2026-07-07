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
import { aggregateUsageBreakdown, resolveUsageWindow, type UsageBreakdown } from './usage-breakdown';

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

  // A stale window (periodEnd in the past — renewal never landed) falls back to
  // the trailing lookback so current spend is never hidden; see resolveUsageWindow.
  const { periodStart, periodEnd } = resolveUsageWindow({
    periodStart: balance?.periodStart ?? null,
    periodEnd: balance?.periodEnd ?? null,
    now: new Date(),
  });

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
        // Upper bound only for a CURRENT period (resolveUsageWindow nulls periodEnd
        // for stale/missing windows), where it excludes nothing today but keeps the
        // window honest if the clock/period ever race.
        ...(periodEnd ? [lte(creditLedger.createdAt, periodEnd)] : []),
      ),
    );

  return aggregateUsageBreakdown(rows, {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd ? periodEnd.toISOString() : null,
  });
}
