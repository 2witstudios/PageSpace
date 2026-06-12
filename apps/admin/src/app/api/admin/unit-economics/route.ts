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
  type Granularity,
} from '@/lib/monitoring';
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

function sanitizeSpreadsheetCell(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvField(value: string | number | null): string {
  const s = sanitizeSpreadsheetCell(value === null ? '' : String(value));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: (string | number | null)[][]): string {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n');
}

export const GET = withAdminAuth(async (_adminUser, request) => {
  try {
    const { searchParams } = new URL(request.url);
    const range = parseRange(searchParams.get('range'));
    const granularity = parseGranularity(searchParams.get('granularity'));
    const format = searchParams.get('format') === 'csv' ? 'csv' : 'json';

    const { startDate, endDate } = getDateRange(range);

    const [summary, byPeriod, byModel, byTier, topSpenders, debtByUser] = await Promise.all([
      getUnitEconomicsSummary(startDate, endDate),
      getMarginByPeriod(startDate, endDate, granularity),
      getMarginByModel(startDate, endDate),
      getMarginByTier(startDate, endDate),
      getTopSpendersByMargin(startDate, endDate, 10),
      getOutstandingDebtByUser(10),
    ]);

    if (format === 'csv') {
      const header = ['section', 'key', 'realCostUSD', 'chargedUSD', 'appliedUSD', 'marginUSD', 'marginPct', 'requests', 'debtUSD'];
      const rows: (string | number | null)[][] = [header];

      rows.push(['summary', range, centsToDollars(summary.realCostCents), centsToDollars(summary.chargedCents), centsToDollars(summary.appliedCents), centsToDollars(summary.marginCents), summary.marginPct === null ? '' : summary.marginPct.toFixed(2), summary.requestCount, centsToDollars(summary.debtCents)]);

      for (const r of byPeriod) {
        rows.push(['period', typeof r.period === 'string' ? r.period : String(r.period), centsToDollars(r.realCostCents), centsToDollars(r.chargedCents), centsToDollars(r.appliedCents), centsToDollars(r.marginCents), r.marginPct === null ? '' : r.marginPct.toFixed(2), r.requestCount, '']);
      }

      for (const r of byModel) {
        rows.push(['model', `${r.provider}/${r.model}`, centsToDollars(r.realCostCents), centsToDollars(r.chargedCents), centsToDollars(r.appliedCents), centsToDollars(r.marginCents), r.marginPct === null ? '' : r.marginPct.toFixed(2), r.requestCount, '']);
      }

      for (const r of topSpenders) {
        rows.push(['spender', r.userEmail ?? r.userName ?? r.userId, centsToDollars(r.realCostCents), centsToDollars(r.chargedCents), centsToDollars(r.appliedCents), centsToDollars(r.marginCents), r.marginPct === null ? '' : r.marginPct.toFixed(2), r.requestCount, '']);
      }

      for (const r of debtByUser) {
        rows.push(['debt', r.userEmail ?? r.userName ?? r.userId, '', '', '', '', '', '', centsToDollars(r.debtCents)]);
      }

      return new NextResponse(toCsv(rows), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="unit-economics-${range}.csv"`,
        },
      });
    }

    return NextResponse.json({ range, granularity, startDate, endDate, summary, byPeriod, byModel, byTier, topSpenders, debtByUser });
  } catch (error) {
    loggers.api.error('Error fetching unit-economics data:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch unit-economics data' }, { status: 500 });
  }
});
