/**
 * Pure aggregation for the user-facing "where my credits go" breakdown.
 *
 * Input is one row per billed AI call (credit_ledger usage row joined to its
 * aiUsageLogs row); output groups customer-facing spend by feature (`source`) and by
 * model. No I/O — the DB read lives in `usage-breakdown-query.ts`, which calls this.
 *
 * Spend is the LEDGER's charged amount (post-markup, what the user actually paid in
 * credits), carried as `chargeMillicents` (1 cent = 1000 millicents) for sub-cent
 * precision; never the raw provider `cost` on aiUsageLogs.
 */

import {
  normalizeUsageSource,
  USAGE_SOURCE_LABELS,
  type AIUsageSource,
} from '@pagespace/lib/monitoring/usage-source';

export interface UsageLedgerRow {
  source: string | null;
  model: string | null;
  provider: string | null;
  chargeMillicents: number | null;
  totalTokens: number | null;
  /** The machine's backing Terminal page (source:'terminal' rows only; null for every other source). */
  pageId: string | null;
  /** The backing page's title, pre-joined by the query — null when the page was deleted or unresolvable. */
  pageTitle: string | null;
  /** Active-window duration in milliseconds (source:'terminal' rows only). */
  durationMs: number | null;
}

export interface UsageBreakdownPeriod {
  periodStart: string | null;
  periodEnd: string | null;
}

/** Fallback lookback when the user has no usable billing-period window. */
export const USAGE_FALLBACK_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Resolve the time window the usage breakdown queries over. The stored billing
 * period is only trusted while it is CURRENT: paid-tier periods roll on Stripe
 * `invoice.paid`, so an account whose renewal never landed (comped/founder, or a
 * webhook gap) keeps a stale `monthlyPeriodEnd` forever — and a window clamped to
 * it would hide ALL usage after that date (the 2026-07-07 audit found a month of
 * real spend invisible this way). A stale or missing window therefore falls back
 * to the trailing lookback ending now: honest "recent usage", never a frozen one.
 *
 * Deliberate trade-offs:
 * - A null `periodEnd` WITH a start is kept as an open-ended current window
 *   (display semantics), even though the credit gate treats that state as
 *   expired and will stamp a window on the user's next AI call.
 * - During a brief renewal lag (invoice retrying for a day or two) the fallback
 *   fires too, so the page briefly shows trailing-30d instead of the lapsed
 *   period. Showing current spend during the lag beats freezing the page on the
 *   old period — which is exactly the audit bug this fixes.
 */
export function resolveUsageWindow({
  periodStart,
  periodEnd,
  now,
}: {
  periodStart: Date | null;
  periodEnd: Date | null;
  now: Date;
}): { periodStart: Date; periodEnd: Date | null } {
  const stale = periodStart === null || (periodEnd !== null && periodEnd < now);
  if (stale) return { periodStart: new Date(now.getTime() - USAGE_FALLBACK_LOOKBACK_MS), periodEnd: null };
  return { periodStart, periodEnd };
}

export interface UsageFeatureRow {
  source: AIUsageSource;
  label: string;
  spendCents: number;
  tokens: number;
  calls: number;
  sharePct: number;
}

export interface UsageModelRow {
  model: string;
  provider: string;
  spendCents: number;
  tokens: number;
  calls: number;
  sharePct: number;
}

export interface UsageMachineRow {
  /** Null when the row predates pageId attribution or has no backing page (e.g. the global assistant). */
  pageId: string | null;
  label: string;
  activeSeconds: number;
  spendCents: number;
  calls: number;
  /** Share of TERMINAL spend (not overall spend) this machine accounts for. */
  sharePct: number;
}

export interface UsageBreakdown extends UsageBreakdownPeriod {
  totalSpendCents: number;
  byFeature: UsageFeatureRow[];
  byModel: UsageModelRow[];
  byMachine: UsageMachineRow[];
}

/** Internal accumulator (spend tracked in millicents for precision). */
interface Bucket {
  millicents: number;
  tokens: number;
  calls: number;
}

const millicentsToCents = (millicents: number): number =>
  Math.round((millicents / 1000) * 100) / 100;

// Share of total spend, 0–100. A row with real (nonzero) spend never rounds down to a
// bare "0%" with an empty bar — it floors at 1% so the UI reflects that it cost something.
const sharePct = (millicents: number, totalMillicents: number): number => {
  if (totalMillicents <= 0 || millicents <= 0) return 0;
  return Math.max(1, Math.round((millicents / totalMillicents) * 100));
};

export function aggregateUsageBreakdown(
  rows: UsageLedgerRow[],
  period: UsageBreakdownPeriod,
): UsageBreakdown {
  const featureBuckets = new Map<AIUsageSource, Bucket>();
  const modelBuckets = new Map<string, Bucket & { model: string; provider: string }>();
  const machineBuckets = new Map<string, { millicents: number; calls: number; activeSeconds: number; pageId: string | null; label: string }>();
  let totalMillicents = 0;
  let terminalMillicents = 0;

  for (const r of rows) {
    const charge = r.chargeMillicents ?? 0;
    const tokens = r.totalTokens ?? 0;
    totalMillicents += charge;

    const source = normalizeUsageSource(r.source);
    const fb = featureBuckets.get(source) ?? { millicents: 0, tokens: 0, calls: 0 };
    fb.millicents += charge;
    fb.tokens += tokens;
    fb.calls += 1;
    featureBuckets.set(source, fb);

    const model = r.model ?? 'unknown';
    const provider = r.provider ?? 'unknown';
    // JSON-tuple key: collision-proof regardless of characters in model/provider.
    const key = JSON.stringify([model, provider]);
    const mb = modelBuckets.get(key) ?? { millicents: 0, tokens: 0, calls: 0, model, provider };
    mb.millicents += charge;
    mb.tokens += tokens;
    mb.calls += 1;
    modelBuckets.set(key, mb);

    if (source === 'terminal') {
      terminalMillicents += charge;
      // Rows without a resolvable page (pre-attribution history, or a machine with
      // no backing page e.g. the global assistant) collapse into one bucket rather
      // than being dropped, so terminal spend is never silently under-reported.
      const machineKey = r.pageId ?? '__unattributed__';
      const label = r.pageId ? (r.pageTitle ?? 'Untitled machine') : 'Unattributed machine';
      const mkb = machineBuckets.get(machineKey) ?? { millicents: 0, calls: 0, activeSeconds: 0, pageId: r.pageId, label };
      mkb.millicents += charge;
      mkb.calls += 1;
      mkb.activeSeconds += (r.durationMs ?? 0) / 1000;
      machineBuckets.set(machineKey, mkb);
    }
  }

  const byFeature: UsageFeatureRow[] = Array.from(featureBuckets.entries())
    .map(([source, b]) => ({
      source,
      label: USAGE_SOURCE_LABELS[source],
      spendCents: millicentsToCents(b.millicents),
      tokens: b.tokens,
      calls: b.calls,
      sharePct: sharePct(b.millicents, totalMillicents),
    }))
    .sort((a, b) => b.spendCents - a.spendCents);

  const byModel: UsageModelRow[] = Array.from(modelBuckets.values())
    .map((b) => ({
      model: b.model,
      provider: b.provider,
      spendCents: millicentsToCents(b.millicents),
      tokens: b.tokens,
      calls: b.calls,
      sharePct: sharePct(b.millicents, totalMillicents),
    }))
    .sort((a, b) => b.spendCents - a.spendCents);

  const byMachine: UsageMachineRow[] = Array.from(machineBuckets.values())
    .map((b) => ({
      pageId: b.pageId,
      label: b.label,
      activeSeconds: Math.round(b.activeSeconds),
      spendCents: millicentsToCents(b.millicents),
      calls: b.calls,
      sharePct: sharePct(b.millicents, terminalMillicents),
    }))
    .sort((a, b) => b.spendCents - a.spendCents);

  return {
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    totalSpendCents: millicentsToCents(totalMillicents),
    byFeature,
    byModel,
    byMachine,
  };
}
