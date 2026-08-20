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
  SANDBOX_STORAGE_MODELS,
  USAGE_SOURCE_LABELS,
  type AIUsageSource,
} from '@pagespace/lib/monitoring/usage-source';

export interface UsageLedgerRow {
  source: string | null;
  model: string | null;
  provider: string | null;
  chargeMillicents: number | null;
  totalTokens: number | null;
  /** The agent session's backing agent page (source:'terminal' rows only; null for every other source, and for a global-assistant session). */
  pageId: string | null;
  /** The backing page's title, pre-joined by the query — null when the page was deleted or unresolvable. */
  pageTitle: string | null;
  /** Active-window duration in milliseconds (source:'terminal' rows only). */
  durationMs: number | null;
  /**
   * The shared analytics session column. For an ENVIRONMENT storage charge
   * (`model: SANDBOX_STORAGE_MODELS.env`) it carries the `drive_envs` id — the
   * only handle those rows have, since they are page-less by construction.
   */
  sessionId: string | null;
  /** The environment's name, pre-joined by the query — null once the env row is gone. */
  envName: string | null;
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

export interface UsageAgentSessionRow {
  /** Null when the row predates pageId attribution or has no backing page (e.g. the global assistant). */
  pageId: string | null;
  label: string;
  activeSeconds: number;
  spendCents: number;
  calls: number;
  /** Share of TERMINAL spend (not overall spend) this agent session accounts for. */
  sharePct: number;
}

/**
 * One environment's persistence spend this period.
 *
 * Its OWN section, deliberately not a line in `byAgentSession`. An env storage
 * row is `source: 'terminal'` with no `pageId`, so it used to fall into that
 * view's catch-all "Unattributed agent" bucket — and once environments are a
 * thing users create and name, a drive's shared machine reading as an
 * unattributed agent is simply a wrong answer, not a rounding one. It is also
 * excluded from that section's denominator, so an agent's share of agent spend
 * no longer moves when an unrelated environment is billed for its disk.
 *
 * There is no `activeSeconds`: an environment is billed for the disk it keeps,
 * not for a wall-clock window, and every one of these rows carries a zero
 * duration. Reporting "0s" beside a real charge would read as a bug.
 */
export interface UsageEnvironmentRow {
  /** `drive_envs.id`, or null for a charge whose env id was never recorded. */
  envId: string | null;
  label: string;
  spendCents: number;
  calls: number;
  /** Share of ENVIRONMENT spend (not overall spend) this environment accounts for. */
  sharePct: number;
}

export interface UsageBreakdown extends UsageBreakdownPeriod {
  totalSpendCents: number;
  byFeature: UsageFeatureRow[];
  byModel: UsageModelRow[];
  byAgentSession: UsageAgentSessionRow[];
  byEnvironment: UsageEnvironmentRow[];
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
  const agentSessionBuckets = new Map<string, { millicents: number; calls: number; activeSeconds: number; pageId: string | null; label: string }>();
  const environmentBuckets = new Map<string, { millicents: number; calls: number; envId: string | null; label: string }>();
  let totalMillicents = 0;
  let agentSessionMillicents = 0;
  let environmentMillicents = 0;

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

    if (source === 'terminal' && r.model === SANDBOX_STORAGE_MODELS.env) {
      // An ENVIRONMENT's disk. Split off BEFORE the per-agent bucketing below,
      // which is the whole point: these rows have no `pageId` and would
      // otherwise land in its "Unattributed agent" line and its denominator.
      // The env id rides on `sessionId` (see `sandbox-storage-billing.ts`) and
      // the name is resolved by the query; a name that no longer resolves means
      // the env was deleted, which is a fact worth showing rather than hiding.
      environmentMillicents += charge;
      const envKey = r.sessionId ?? '__unidentified_env__';
      const envLabel = r.envName ?? 'Deleted environment';
      const eb = environmentBuckets.get(envKey) ?? { millicents: 0, calls: 0, envId: r.sessionId, label: envLabel };
      eb.millicents += charge;
      eb.calls += 1;
      environmentBuckets.set(envKey, eb);
    } else if (source === 'terminal') {
      agentSessionMillicents += charge;
      // Rows without a resolvable page (pre-attribution history, or a session
      // with no backing page e.g. the global assistant) collapse into one
      // bucket rather than being dropped, so terminal spend is never
      // silently under-reported.
      const sessionKey = r.pageId ?? '__unattributed__';
      const label = r.pageId ? (r.pageTitle ?? 'Untitled agent') : 'Unattributed agent';
      const askb = agentSessionBuckets.get(sessionKey) ?? { millicents: 0, calls: 0, activeSeconds: 0, pageId: r.pageId, label };
      askb.millicents += charge;
      askb.calls += 1;
      askb.activeSeconds += (r.durationMs ?? 0) / 1000;
      agentSessionBuckets.set(sessionKey, askb);
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

  const byAgentSession: UsageAgentSessionRow[] = Array.from(agentSessionBuckets.values())
    .map((b) => ({
      pageId: b.pageId,
      label: b.label,
      activeSeconds: Math.round(b.activeSeconds),
      spendCents: millicentsToCents(b.millicents),
      calls: b.calls,
      sharePct: sharePct(b.millicents, agentSessionMillicents),
    }))
    .sort((a, b) => b.spendCents - a.spendCents);

  const byEnvironment: UsageEnvironmentRow[] = Array.from(environmentBuckets.values())
    .map((b) => ({
      envId: b.envId,
      label: b.label,
      spendCents: millicentsToCents(b.millicents),
      calls: b.calls,
      sharePct: sharePct(b.millicents, environmentMillicents),
    }))
    .sort((a, b) => b.spendCents - a.spendCents);

  return {
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    totalSpendCents: millicentsToCents(totalMillicents),
    byFeature,
    byModel,
    byAgentSession,
    byEnvironment,
  };
}
