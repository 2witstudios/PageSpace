import { NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/auth';
import {
  getDateRange,
  getUnitEconomicsSummary,
  getMarginByPeriod,
  getMarginByModel,
  getMarginByTier,
  getTopSpendersByMargin,
  getOutstandingDebtByUser,
  getTokenUsageSummary,
  getTokenUsageByModel,
  getTokenUsageByPeriod,
  getTokenUsageByUser,
  getProviderCostRollup,
  getCreditRevenue,
  getActiveSubscriptionsByTier,
  getCreditLiability,
  getLiveHolds,
  getBalanceDriftAlerts,
  getNegativeMarginAccounts,
  type Granularity,
} from '@/lib/monitoring';
import {
  MARKUP_BPS,
  TIER_MONTHLY_ALLOWANCE_CENTS,
} from '@pagespace/lib/billing/credit-pricing';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { toCsv } from '@/lib/csv';

type Range = '24h' | '7d' | '30d' | 'all';

function parseRange(value: string | null): Range {
  return value === '24h' || value === '7d' || value === '30d' || value === 'all' ? value : '30d';
}

function parseGranularity(value: string | null): Granularity {
  return value === 'month' ? 'month' : 'day';
}

function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function fmtPct(value: number | null): string {
  return value === null ? '' : value.toFixed(2);
}

export const GET = withAdminAuth(async (_adminUser, request) => {
  try {
    const { searchParams } = new URL(request.url);
    const range = parseRange(searchParams.get('range'));
    const granularity = parseGranularity(searchParams.get('granularity'));
    const format = searchParams.get('format') === 'csv' ? 'csv' : 'json';

    const { startDate, endDate } = getDateRange(range);

    const [
      summary,
      marginByPeriod,
      marginByModel,
      marginByTier,
      topSpenders,
      debtByUser,
      tokenSummary,
      tokensByModel,
      tokensByPeriod,
      tokensByUser,
      providerCost,
      creditRevenue,
      subscriptionsByTier,
      liability,
      holds,
      balanceDrift,
      negativeMargin,
    ] = await Promise.all([
      getUnitEconomicsSummary(startDate, endDate),
      getMarginByPeriod(startDate, endDate, granularity),
      getMarginByModel(startDate, endDate),
      getMarginByTier(startDate, endDate),
      getTopSpendersByMargin(startDate, endDate, 10),
      getOutstandingDebtByUser(10),
      getTokenUsageSummary(startDate, endDate),
      getTokenUsageByModel(startDate, endDate, 50),
      getTokenUsageByPeriod(startDate, endDate, granularity),
      getTokenUsageByUser(startDate, endDate, 10),
      getProviderCostRollup(startDate, endDate),
      getCreditRevenue(startDate, endDate),
      getActiveSubscriptionsByTier(),
      getCreditLiability(),
      getLiveHolds(),
      getBalanceDriftAlerts(),
      getNegativeMarginAccounts(startDate, endDate),
    ]);

    const enforcement = {
      enabled: true,
      markupBps: MARKUP_BPS,
      tierAllowanceCents: TIER_MONTHLY_ALLOWANCE_CENTS,
    };

    // Top-up revenue is real cash; monthly grants are allowance, never summed
    // with it. Counts stay in so reconciliation can tell one whale top-up
    // apart from hundreds of small ones.
    const revenue = {
      topupCents: creditRevenue.topupCents,
      topupCount: creditRevenue.topupCount,
      monthlyGrantCents: creditRevenue.monthlyGrantCents,
      monthlyGrantCount: creditRevenue.monthlyGrantCount,
    };

    if (format === 'csv') {
      const rows: (string | number | null)[][] = [
        ['section', 'key', 'detail', 'inputTokens', 'outputTokens', 'totalTokens', 'requests', 'realCostUSD', 'chargedUSD', 'appliedUSD', 'marginUSD', 'marginPct', 'amountUSD'],
      ];

      rows.push(['enforcement', 'enabled', String(enforcement.enabled), '', '', '', '', '', '', '', '', '', '']);
      rows.push(['enforcement', 'markupBps', String(enforcement.markupBps), '', '', '', '', '', '', '', '', '', '']);
      for (const [tier, cents] of Object.entries(enforcement.tierAllowanceCents)) {
        rows.push(['enforcement', 'tier_allowance', tier, '', '', '', '', '', '', '', '', '', centsToDollars(cents)]);
      }

      rows.push(['summary', range, '', '', '', '', summary.requestCount, centsToDollars(summary.realCostCents), centsToDollars(summary.chargedCents), centsToDollars(summary.appliedCents), centsToDollars(summary.marginCents), fmtPct(summary.marginPct), '']);
      rows.push(['debt', 'all_time_total', '', '', '', '', '', '', '', '', '', '', centsToDollars(summary.debtCents)]);

      for (const r of marginByPeriod) {
        rows.push(['margin_period', typeof r.period === 'string' ? r.period : String(r.period), '', '', '', '', r.requestCount, centsToDollars(r.realCostCents), centsToDollars(r.chargedCents), centsToDollars(r.appliedCents), centsToDollars(r.marginCents), fmtPct(r.marginPct), '']);
      }
      for (const r of marginByModel) {
        rows.push(['margin_model', `${r.provider}/${r.model}`, '', '', '', '', r.requestCount, centsToDollars(r.realCostCents), centsToDollars(r.chargedCents), centsToDollars(r.appliedCents), centsToDollars(r.marginCents), fmtPct(r.marginPct), '']);
      }
      for (const r of marginByTier) {
        rows.push(['margin_tier', r.tier, '', '', '', '', r.requestCount, centsToDollars(r.realCostCents), centsToDollars(r.chargedCents), centsToDollars(r.appliedCents), centsToDollars(r.marginCents), fmtPct(r.marginPct), '']);
      }
      for (const r of providerCost) {
        rows.push(['provider_cost', `${r.provider}/${r.model}`, r.coverage, '', '', '', r.requestCount, centsToDollars(r.realCostCents), centsToDollars(r.chargedCents), '', centsToDollars(r.marginCents), fmtPct(r.marginPct), '']);
      }

      rows.push(['tokens_summary', range, '', tokenSummary.inputTokens, tokenSummary.outputTokens, tokenSummary.totalTokens, tokenSummary.requestCount, '', '', '', '', '', '']);
      for (const r of tokensByModel) {
        rows.push(['tokens_model', r.provider, r.model, r.inputTokens, r.outputTokens, r.totalTokens, r.requestCount, '', '', '', '', '', '']);
      }
      for (const r of tokensByPeriod) {
        rows.push(['tokens_period', typeof r.period === 'string' ? r.period : String(r.period), '', r.inputTokens, r.outputTokens, r.totalTokens, r.requestCount, '', '', '', '', '', '']);
      }
      for (const r of tokensByUser) {
        rows.push(['tokens_user', r.userEmail ?? r.userName ?? r.userId, '', r.inputTokens, r.outputTokens, r.totalTokens, r.requestCount, '', '', '', '', '', '']);
      }

      rows.push(['revenue', 'topup_purchase', String(revenue.topupCount), '', '', '', '', '', '', '', '', '', centsToDollars(revenue.topupCents)]);
      rows.push(['revenue', 'monthly_grant', String(revenue.monthlyGrantCount), '', '', '', '', '', '', '', '', '', centsToDollars(revenue.monthlyGrantCents)]);
      for (const r of subscriptionsByTier) {
        rows.push(['subscriptions', r.tier, String(r.count), '', '', '', '', '', '', '', '', '', '']);
      }
      rows.push(['liability', 'total', String(liability.userCount), '', '', '', '', '', '', '', '', '', centsToDollars(liability.totalLiabilityCents)]);
      rows.push(['liability', 'monthly_remaining', '', '', '', '', '', '', '', '', '', '', centsToDollars(liability.monthlyRemainingCents)]);
      rows.push(['liability', 'topup_remaining', '', '', '', '', '', '', '', '', '', '', centsToDollars(liability.topupRemainingCents)]);
      rows.push(['holds', 'live', String(holds.holdCount), '', '', '', '', '', '', '', '', '', centsToDollars(holds.heldCents)]);

      for (const r of topSpenders) {
        rows.push(['spender', r.userEmail ?? r.userName ?? r.userId, '', '', '', '', r.requestCount, centsToDollars(r.realCostCents), centsToDollars(r.chargedCents), centsToDollars(r.appliedCents), centsToDollars(r.marginCents), fmtPct(r.marginPct), '']);
      }
      for (const r of debtByUser) {
        rows.push(['debt_user', r.userEmail ?? r.userName ?? r.userId, '', '', '', '', '', '', '', '', '', '', centsToDollars(r.debtCents)]);
      }
      for (const r of balanceDrift) {
        rows.push(['alert_balance_drift', r.userEmail ?? r.userName ?? r.userId, `expected ${centsToDollars(r.expectedSpendableCents)} materialized ${centsToDollars(r.materializedSpendableCents)}`, '', '', '', '', '', '', '', '', '', centsToDollars(r.driftCents)]);
      }
      for (const r of negativeMargin) {
        rows.push(['alert_negative_margin', r.userEmail ?? r.userName ?? r.userId, '', '', '', '', r.requestCount, centsToDollars(r.realCostCents), centsToDollars(r.chargedCents), '', centsToDollars(r.marginCents), fmtPct(r.marginPct), '']);
      }

      return new NextResponse(toCsv(rows), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="billing-${range}.csv"`,
        },
      });
    }

    return NextResponse.json({
      range,
      granularity,
      startDate,
      endDate,
      enforcement,
      summary,
      marginByPeriod,
      marginByModel,
      marginByTier,
      providerCost,
      topSpenders,
      debtByUser,
      revenue,
      subscriptionsByTier,
      liability,
      holds,
      alerts: { balanceDrift, negativeMargin },
      tokens: {
        summary: tokenSummary,
        byModel: tokensByModel,
        byPeriod: tokensByPeriod,
        byUser: tokensByUser,
      },
    });
  } catch (error) {
    loggers.api.error('Error fetching billing data:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch billing data' }, { status: 500 });
  }
});
