import { NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/auth';
import {
  getDateRange,
  getTokenUsageSummary,
  getTokenUsageByModel,
  getTokenUsageByPeriod,
  getTokenUsageByUser,
  getProviderCostRollup,
  getCreditRevenue,
  getActiveSubscriptionsByTier,
  getCreditLiability,
  getLiveHolds,
  type Granularity,
} from '@/lib/monitoring';
import {
  isCreditsEnforcementEnabled,
  MARKUP_BPS,
  TIER_MONTHLY_ALLOWANCE_CENTS,
} from '@pagespace/lib/billing/credit-pricing';
import { loggers } from '@pagespace/lib/logging/logger-config';

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

/**
 * Neutralize spreadsheet formula injection: a cell starting with =, +, -, or @
 * is evaluated as a formula by Excel/Sheets. Prefix attacker-controlled text
 * (names/emails/model ids) with a single quote so it renders literally — but
 * EXEMPT plain numbers so legitimate negative exports stay numeric.
 */
function sanitizeSpreadsheetCell(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value)) return value; // plain (possibly negative) number — safe
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

/** Escape a CSV field per RFC 4180 (quote if it contains comma, quote, or newline). */
function csvField(value: string | number | null): string {
  const s = sanitizeSpreadsheetCell(value === null ? '' : String(value));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: (string | number | null)[][]): string {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n');
}

/**
 * GET /api/admin/ai-billing
 * Comprehensive AI-billing snapshot: token volume, provider cost (real vs
 * estimated), Stripe credit revenue, outstanding liability + live holds, and the
 * enforcement-status banner. ADMIN ONLY — exposes revenue/cost internals.
 *
 * Query params:
 *   - range:       24h | 7d | 30d (default) | all  — windows token/cost/revenue
 *   - granularity: day (default) | month            — token time-series bucketing
 *   - format:      json (default) | csv             — flat multi-section export
 */
export const GET = withAdminAuth(async (_adminUser, request) => {
  try {
    const { searchParams } = new URL(request.url);
    const range = parseRange(searchParams.get('range'));
    const granularity = parseGranularity(searchParams.get('granularity'));
    const format = searchParams.get('format') === 'csv' ? 'csv' : 'json';

    const { startDate, endDate } = getDateRange(range);

    const [
      tokenSummary,
      tokensByModel,
      tokensByPeriod,
      tokensByUser,
      providerCost,
      revenue,
      subscriptionsByTier,
      liability,
      holds,
    ] = await Promise.all([
      getTokenUsageSummary(startDate, endDate),
      getTokenUsageByModel(startDate, endDate, 50),
      getTokenUsageByPeriod(startDate, endDate, granularity),
      getTokenUsageByUser(startDate, endDate, 10),
      getProviderCostRollup(startDate, endDate),
      getCreditRevenue(startDate, endDate),
      getActiveSubscriptionsByTier(),
      getCreditLiability(),
      getLiveHolds(),
    ]);

    const enforcement = {
      enabled: isCreditsEnforcementEnabled(),
      markupBps: MARKUP_BPS,
      tierAllowanceCents: TIER_MONTHLY_ALLOWANCE_CENTS,
    };

    if (format === 'csv') {
      const rows: (string | number | null)[][] = [
        ['section', 'key', 'detail', 'inputTokens', 'outputTokens', 'totalTokens', 'requests', 'realCostUSD', 'chargedUSD', 'amountUSD'],
      ];

      rows.push(['enforcement', 'enabled', String(enforcement.enabled), '', '', '', '', '', '', '']);
      rows.push(['enforcement', 'markupBps', String(enforcement.markupBps), '', '', '', '', '', '', '']);

      rows.push([
        'tokens_summary', range, '',
        tokenSummary.inputTokens, tokenSummary.outputTokens, tokenSummary.totalTokens,
        tokenSummary.requestCount, '', '', '',
      ]);

      for (const r of tokensByModel) {
        rows.push([
          'tokens_model', r.provider, r.model,
          r.inputTokens, r.outputTokens, r.totalTokens, r.requestCount, '', '', '',
        ]);
      }

      for (const r of tokensByPeriod) {
        rows.push([
          'tokens_period', typeof r.period === 'string' ? r.period : String(r.period), '',
          r.inputTokens, r.outputTokens, r.totalTokens, r.requestCount, '', '', '',
        ]);
      }

      for (const r of tokensByUser) {
        rows.push([
          'tokens_user', r.userEmail ?? r.userName ?? r.userId, '',
          r.inputTokens, r.outputTokens, r.totalTokens, r.requestCount, '', '', '',
        ]);
      }

      for (const r of providerCost) {
        rows.push([
          'provider_cost', `${r.provider}/${r.model}`, r.coverage,
          '', '', '', r.requestCount,
          centsToDollars(r.realCostCents), centsToDollars(r.chargedCents), '',
        ]);
      }

      rows.push(['revenue', 'topup_purchase', String(revenue.topupCount), '', '', '', '', '', '', centsToDollars(revenue.topupCents)]);
      rows.push(['revenue', 'monthly_grant', String(revenue.monthlyGrantCount), '', '', '', '', '', '', centsToDollars(revenue.monthlyGrantCents)]);
      for (const r of subscriptionsByTier) {
        rows.push(['subscriptions', r.tier, String(r.count), '', '', '', '', '', '', '']);
      }

      rows.push(['liability', 'total', String(liability.userCount), '', '', '', '', '', '', centsToDollars(liability.totalLiabilityCents)]);
      rows.push(['holds', 'live', String(holds.holdCount), '', '', '', '', '', '', centsToDollars(holds.heldCents)]);

      return new NextResponse(toCsv(rows), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="ai-billing-${range}.csv"`,
        },
      });
    }

    return NextResponse.json({
      range,
      granularity,
      startDate,
      endDate,
      enforcement,
      tokens: {
        summary: tokenSummary,
        byModel: tokensByModel,
        byPeriod: tokensByPeriod,
        byUser: tokensByUser,
      },
      providerCost,
      revenue: { ...revenue, subscriptionsByTier },
      liability,
      holds,
    });
  } catch (error) {
    loggers.api.error('Error fetching ai-billing data:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch ai-billing data' },
      { status: 500 },
    );
  }
});
