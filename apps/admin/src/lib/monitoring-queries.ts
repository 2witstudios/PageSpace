/**
 * Database queries for monitoring dashboard
 */

import { db } from '@pagespace/db/db'
import { sql, eq, and, or, gt, asc, gte, lte, lt, desc, count, inArray, isNull, isNotNull } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { apiMetrics, aiUsageLogs, systemLogs, errorLogs, activityLogs } from '@pagespace/db/schema/monitoring';
import { sessions } from '@pagespace/db/schema/sessions';
import { creditLedger, creditBalances, creditHolds } from '@pagespace/db/schema/credits';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import type { SQL } from '@pagespace/db/operators';
import { computeBalanceDrift, isNegativeMargin } from '@pagespace/lib/billing/credit-core';
import { BALANCE_DRIFT_TOLERANCE_CENTS, NEGATIVE_MARGIN_FLOOR_BPS } from '@pagespace/lib/billing/credit-pricing';
import { getTierFromPrice, STRIPE_PRICE_TO_TIER } from './stripe/price-config';
import { stripe } from './stripe/client';
import { TIERS, type SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { decryptUserDisplayFields } from '@pagespace/lib/auth/user-repository';
import { maskEmail } from '@pagespace/lib/audit/mask-email';
import { isClickHouseEnabled, getClickHouseClient } from '@pagespace/lib/observability/clickhouse-client';
import {
  getLogsByLevel as chGetLogsByLevel,
  getRecentErrors as chGetRecentErrors,
  getVolumeOverTime as chGetVolumeOverTime,
  getTopEndpoints as chGetTopEndpoints,
  getRequestErrorCounts as chGetRequestErrorCounts,
  getErrorTrends as chGetErrorTrends,
  getErrorPatterns as chGetErrorPatterns,
  getFailedLogins as chGetFailedLogins,
} from '@pagespace/lib/observability/analytics-reads';
import type { ClickHouseClient } from '@pagespace/lib/observability/clickhouse-client';

/**
 * Post-cutover (#890 Phase 3) new analytics rows land only in ClickHouse, so
 * the readers over the 4 moved tables (apiMetrics, systemLogs,
 * userActivities, errorLogs) query CH when the flag is on — server-side
 * only, aggregations in CH SQL — and hit PG exactly as before when it is
 * off. Returns null when the tier is off so callers fall through to PG.
 * NOTE: getUserActivity is NOT gated — it reads activityLogs (Phase 5), not
 * one of the moved tables; the sessions-based active-user count stays PG too.
 */
function clickHouseClientIfEnabled(): ClickHouseClient | null {
  return isClickHouseEnabled() ? getClickHouseClient() : null;
}

/** Active users: distinct sessions touched in the last 15 minutes (main PG in both modes). */
async function getActiveSessionUserCount(): Promise<number> {
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
  const activeUsers = await db
    .select({
      count: sql<number>`COUNT(DISTINCT ${sessions.userId})::int`,
    })
    .from(sessions)
    .where(and(gte(sessions.lastUsedAt, fifteenMinutesAgo), isNull(sessions.revokedAt)));
  return activeUsers[0]?.count || 0;
}

/**
 * Get system health overview
 */
export async function getSystemHealth(startDate?: Date, endDate?: Date) {
  const chClient = clickHouseClientIfEnabled();
  if (chClient) {
    const window = { startDate, endDate };
    const [logsByLevel, recentErrors, activeUserCount] = await Promise.all([
      chGetLogsByLevel(chClient, window),
      chGetRecentErrors(chClient, window, 20),
      getActiveSessionUserCount(),
    ]);
    return {
      logsByLevel,
      recentErrors: recentErrors.map((entry) => ({
        ...entry,
        errorMessage: entry.errorMessage || entry.message,
      })),
      activeUserCount,
    };
  }

  const logConditions: SQL[] = [];

  if (startDate) {
    logConditions.push(gte(systemLogs.timestamp, startDate));
  }
  if (endDate) {
    logConditions.push(lte(systemLogs.timestamp, endDate));
  }

  const logsByLevel = await db
    .select({
      level: systemLogs.level,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(systemLogs)
    .where(logConditions.length > 0 ? and(...logConditions) : undefined)
    .groupBy(systemLogs.level);

  const errorConditions: SQL[] = [];
  if (startDate) errorConditions.push(gte(errorLogs.timestamp, startDate));
  if (endDate) errorConditions.push(lte(errorLogs.timestamp, endDate));

  const recentErrors = await db
    .select({
      id: errorLogs.id,
      timestamp: errorLogs.timestamp,
      message: errorLogs.message,
      errorName: errorLogs.name,
      errorMessage: errorLogs.stack,
      endpoint: errorLogs.endpoint,
      userId: errorLogs.userId,
    })
    .from(errorLogs)
    .where(errorConditions.length > 0 ? and(...errorConditions) : undefined)
    .orderBy(desc(errorLogs.timestamp))
    .limit(20);

  // Active users: distinct sessions touched in last 15 minutes (sessions.lastUsedAt is
  // updated non-blocking on every authenticated request — reliable signal)
  const activeUserCount = await getActiveSessionUserCount();

  return {
    logsByLevel: logsByLevel.map((entry) => ({
      level: entry.level,
      count: entry.count,
    })),
    recentErrors: recentErrors.map((entry) => ({
      ...entry,
      errorMessage: entry.errorMessage || entry.message,
    })),
    activeUserCount,
  };
}

/**
 * Get API metrics
 */
export async function getApiMetrics(startDate?: Date, endDate?: Date) {
  const chClient = clickHouseClientIfEnabled();
  if (chClient) {
    const window = { startDate, endDate };
    const [volumeOverTime, topEndpoints, requestCounts] = await Promise.all([
      chGetVolumeOverTime(chClient, window),
      chGetTopEndpoints(chClient, window),
      chGetRequestErrorCounts(chClient, window),
    ]);
    return {
      volumeOverTime,
      topEndpoints,
      errorRate: requestCounts.total > 0 ? (requestCounts.errors / requestCounts.total) * 100 : 0,
      totalRequests: requestCounts.total,
    };
  }

  const conditions = [];

  if (startDate) {
    conditions.push(gte(apiMetrics.timestamp, startDate));
  }
  if (endDate) {
    conditions.push(lte(apiMetrics.timestamp, endDate));
  }

  // Get request volume over time - using simpler Drizzle query instead of raw SQL
  const volumeOverTime = await db
    .select({
      hour: sql<string>`DATE_TRUNC('hour', ${apiMetrics.timestamp})`,
      count: count(),
      avg_response_time: sql<number>`AVG(${apiMetrics.duration})`,
    })
    .from(apiMetrics)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(sql`DATE_TRUNC('hour', ${apiMetrics.timestamp})`)
    .orderBy(desc(sql`DATE_TRUNC('hour', ${apiMetrics.timestamp})`))
    .limit(168);

  // Get top endpoints
  const topEndpoints = await db
    .select({
      endpoint: apiMetrics.endpoint,
      count: count(),
      avgResponseTime: sql<number>`AVG(${apiMetrics.duration})`,
    })
    .from(apiMetrics)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(apiMetrics.endpoint)
    .orderBy(desc(count()))
    .limit(10);

  // Get error rate
  const totalRequests = await db
    .select({ count: count() })
    .from(apiMetrics)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const errorRequests = await db
    .select({ count: count() })
    .from(apiMetrics)
    .where(and(
      gte(apiMetrics.statusCode, 400),
      ...(conditions.length > 0 ? conditions : [])
    ));

  const errorRate = totalRequests[0]?.count > 0 
    ? (errorRequests[0]?.count / totalRequests[0]?.count) * 100 
    : 0;

  return {
    volumeOverTime,
    topEndpoints,
    errorRate,
    totalRequests: totalRequests[0]?.count || 0,
  };
}

/**
 * Get user activity data
 * Uses activityLogs (comprehensive audit trail written on every page/drive/member operation)
 * NOT userActivities (only written on conversation deletion — effectively empty)
 */
export async function getUserActivity(startDate?: Date, endDate?: Date) {
  const conditions: SQL[] = [isNotNull(activityLogs.userId)];

  if (startDate) {
    conditions.push(gte(activityLogs.timestamp, startDate));
  }
  if (endDate) {
    conditions.push(lte(activityLogs.timestamp, endDate));
  }

  const heatmapData = await db
    .select({
      day_of_week: sql<number>`EXTRACT(DOW FROM ${activityLogs.timestamp})`,
      hour_of_day: sql<number>`EXTRACT(HOUR FROM ${activityLogs.timestamp})`,
      activity_count: count(),
    })
    .from(activityLogs)
    .where(and(...conditions))
    .groupBy(
      sql`EXTRACT(DOW FROM ${activityLogs.timestamp})`,
      sql`EXTRACT(HOUR FROM ${activityLogs.timestamp})`
    );

  const mostActiveUsers = await db
    .select({
      userId: activityLogs.userId,
      userName: users.name,
      actionCount: count(),
    })
    .from(activityLogs)
    .innerJoin(users, eq(activityLogs.userId, users.id))
    .where(and(...conditions))
    .groupBy(activityLogs.userId, users.name)
    .orderBy(desc(count()))
    .limit(10);

  // operation column stores the action type (create, update, delete, rename, etc.)
  const featureUsage = await db
    .select({
      action: activityLogs.operation,
      count: count(),
    })
    .from(activityLogs)
    .where(and(...conditions))
    .groupBy(activityLogs.operation)
    .orderBy(desc(count()))
    .limit(15);

  return {
    heatmapData,
    mostActiveUsers: await decryptUserDisplayFields(mostActiveUsers),
    featureUsage,
  };
}

const EMAIL_PATTERN = /[^\s@"']+@[^\s@"']+\.[^\s@"',)\]}]+/g;

function maskEmailsDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    // Replace every email occurrence, including ones embedded in longer
    // strings ("login failed for jane@example.com").
    return value.replace(EMAIL_PATTERN, (match) => maskEmail(match));
  }
  if (Array.isArray(value)) return value.map(maskEmailsDeep);
  if (value && typeof value === 'object') {
    const masked: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      masked[key] = maskEmailsDeep(entry);
    }
    return masked;
  }
  return value;
}

/**
 * Mask every email occurrence in log metadata — at any nesting depth and
 * embedded anywhere inside strings — so raw PII never reaches the monitoring
 * UI. Some writers (e.g. account-lockout) already mask before logging;
 * maskEmail is idempotent on masked values.
 */
function maskEmailsInMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return maskEmailsDeep(metadata) as Record<string, unknown>;
}

/**
 * Get error analytics
 */
export async function getErrorAnalytics(startDate?: Date, endDate?: Date) {
  const chClient = clickHouseClientIfEnabled();
  if (chClient) {
    const window = { startDate, endDate };
    const [errorTrendsRaw, errorPatternsRaw, failedLogins] = await Promise.all([
      chGetErrorTrends(chClient, window),
      chGetErrorPatterns(chClient, window),
      chGetFailedLogins(chClient, window),
    ]);
    return {
      errorTrends: errorTrendsRaw.map((item) => ({
        hour: item.hour,
        category: item.category ?? 'other',
        count: item.count.toString(),
      })),
      errorPatterns: errorPatternsRaw.map((pattern) => ({
        name: pattern.name ?? 'Unknown Error',
        category: pattern.endpoint ?? 'general',
        count: pattern.count,
      })),
      failedLogins: failedLogins.map((login) => ({
        timestamp: login.timestamp,
        ip: login.ip,
        metadata: maskEmailsInMetadata(login.metadata),
      })),
    };
  }

  const errorLevelConditions: SQL[] = [eq(systemLogs.level, 'error' as const)];

  if (startDate) {
    errorLevelConditions.push(gte(systemLogs.timestamp, startDate));
  }
  if (endDate) {
    errorLevelConditions.push(lte(systemLogs.timestamp, endDate));
  }

  const errorTrendsRaw = await db
    .select({
      hour: sql<string>`DATE_TRUNC('hour', ${systemLogs.timestamp})`,
      category: systemLogs.category,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(systemLogs)
    .where(and(...errorLevelConditions))
    .groupBy(
      sql`DATE_TRUNC('hour', ${systemLogs.timestamp})`,
      systemLogs.category,
    )
    .orderBy(desc(sql`DATE_TRUNC('hour', ${systemLogs.timestamp})`))
    .limit(168);

  const errorLogConditions: SQL[] = [];

  if (startDate) {
    errorLogConditions.push(gte(errorLogs.timestamp, startDate));
  }
  if (endDate) {
    errorLogConditions.push(lte(errorLogs.timestamp, endDate));
  }

  const errorPatternsRaw = await db
    .select({
      name: errorLogs.name,
      endpoint: errorLogs.endpoint,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(errorLogs)
    .where(errorLogConditions.length > 0 ? and(...errorLogConditions) : undefined)
    .groupBy(errorLogs.name, errorLogs.endpoint)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(20);

  const failedLoginConditions: SQL[] = [
    eq(systemLogs.category, 'auth'),
    or(eq(systemLogs.level, 'warn' as const), eq(systemLogs.level, 'error' as const))!,
  ];

  if (startDate) {
    failedLoginConditions.push(gte(systemLogs.timestamp, startDate));
  }
  if (endDate) {
    failedLoginConditions.push(lte(systemLogs.timestamp, endDate));
  }

  const failedLogins = await db
    .select({
      timestamp: systemLogs.timestamp,
      ip: systemLogs.ip,
      metadata: systemLogs.metadata,
    })
    .from(systemLogs)
    .where(and(...failedLoginConditions))
    .orderBy(desc(systemLogs.timestamp))
    .limit(25);

  return {
    errorTrends: errorTrendsRaw.map((item) => ({
      hour: item.hour,
      category: item.category ?? 'other',
      count: item.count.toString(),
    })),
    errorPatterns: errorPatternsRaw.map((pattern) => ({
      name: pattern.name ?? 'Unknown Error',
      category: pattern.endpoint ?? 'general',
      count: pattern.count,
    })),
    failedLogins: failedLogins.map((login) => ({
      timestamp: login.timestamp,
      ip: login.ip,
      metadata: maskEmailsInMetadata(login.metadata),
    })),
  };
}

/**
 * Get date range for queries
 */
export function getDateRange(range: '24h' | '7d' | '30d' | 'all') {
  const now = new Date();
  let startDate: Date | undefined;
  
  switch (range) {
    case '24h':
      startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case '7d':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case 'all':
    default:
      startDate = undefined;
  }
  
  return { startDate, endDate: now };
}

// ── AI unit economics (real cost vs charged credits vs margin) ────────────────

export type Granularity = 'day' | 'month';

export interface UnitEconomicsSummary {
  realCostCents: number;
  chargedCents: number;
  appliedCents: number;
  requestCount: number;
  /**
   * Total outstanding user debt as an ALL-TIME point-in-time snapshot of
   * `credit_balances.debtCents`. Unlike the other fields, it is NOT scoped to
   * the summary's start/end date range — debt has no time dimension.
   */
  debtCents: number;
  marginCents: number;
  marginPct: number | null;
}

export interface MarginByPeriodRow {
  period: string;
  realCostCents: number;
  chargedCents: number;
  appliedCents: number;
  requestCount: number;
  marginCents: number;
  marginPct: number | null;
}

export interface MarginByModelRow {
  provider: string;
  model: string;
  realCostCents: number;
  chargedCents: number;
  appliedCents: number;
  requestCount: number;
  marginCents: number;
  marginPct: number | null;
}

export interface TopSpenderRow {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  realCostCents: number;
  chargedCents: number;
  appliedCents: number;
  requestCount: number;
  marginCents: number;
  marginPct: number | null;
}

export interface DebtByUserRow {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  debtCents: number;
}

export function computeMarginPct(realCostCents: number, chargedCents: number): number | null {
  if (!realCostCents || realCostCents <= 0) return null;
  return ((chargedCents - realCostCents) / realCostCents) * 100;
}

// Cloud vendors route through OpenRouter; local providers use their own backends.
const CLOUD_VENDOR_PROVIDERS = new Set<string>([
  'openai', 'anthropic', 'google', 'xai', 'deepseek', 'qwen', 'mistral',
  'moonshot', 'minimax', 'meta', 'bytedance', 'ai21', 'inception', 'writer',
]);

function getBackendProvider(uiProvider: string): string {
  return CLOUD_VENDOR_PROVIDERS.has(uiProvider) ? 'openrouter' : uiProvider;
}

const realCostSum = sql<number>`ROUND(COALESCE(SUM(
  CASE
    WHEN ${aiUsageLogs.cost} IS NOT NULL THEN ${aiUsageLogs.cost}::numeric * 100
    ELSE ${creditLedger.realCostCents}
  END
), 0))::int`;
const chargedSum = sql<number>`ROUND(COALESCE(SUM(COALESCE(${creditLedger.chargeMillicents}, ABS(${creditLedger.amountCents}) * 1000)), 0) / 1000.0)::int`;
const appliedSum = sql<number>`COALESCE(SUM(ABS(${creditLedger.appliedCents})), 0)::int`;

function usageConditions(startDate?: Date, endDate?: Date): SQL[] {
  const conditions: SQL[] = [eq(creditLedger.entryType, 'usage')];
  if (startDate) conditions.push(gte(creditLedger.createdAt, startDate));
  if (endDate) conditions.push(lte(creditLedger.createdAt, endDate));
  return conditions;
}

export async function getUnitEconomicsSummary(
  startDate?: Date,
  endDate?: Date,
): Promise<UnitEconomicsSummary> {
  const usage = await db
    .select({
      realCostCents: realCostSum,
      chargedCents: chargedSum,
      appliedCents: appliedSum,
      requestCount: count(),
    })
    .from(creditLedger)
    .leftJoin(aiUsageLogs, eq(creditLedger.aiUsageLogId, aiUsageLogs.id))
    .where(and(...usageConditions(startDate, endDate)));

  const debt = await db
    .select({ debtCents: sql<number>`COALESCE(SUM(${creditBalances.debtCents}), 0)::int` })
    .from(creditBalances);

  const realCostCents = usage[0]?.realCostCents ?? 0;
  const chargedCents = usage[0]?.chargedCents ?? 0;
  const appliedCents = usage[0]?.appliedCents ?? 0;
  const requestCount = usage[0]?.requestCount ?? 0;
  const debtCents = debt[0]?.debtCents ?? 0;

  return {
    realCostCents,
    chargedCents,
    appliedCents,
    requestCount,
    debtCents,
    marginCents: chargedCents - realCostCents,
    marginPct: computeMarginPct(realCostCents, chargedCents),
  };
}

export async function getMarginByPeriod(
  startDate?: Date,
  endDate?: Date,
  granularity: Granularity = 'day',
): Promise<MarginByPeriodRow[]> {
  if (granularity !== 'day' && granularity !== 'month') {
    throw new Error(`Invalid granularity: ${granularity}`);
  }
  const periodExpr = sql<string>`DATE_TRUNC('${sql.raw(granularity)}', ${creditLedger.createdAt})`;

  const rows = await db
    .select({
      period: periodExpr,
      realCostCents: realCostSum,
      chargedCents: chargedSum,
      appliedCents: appliedSum,
      requestCount: count(),
    })
    .from(creditLedger)
    .leftJoin(aiUsageLogs, eq(creditLedger.aiUsageLogId, aiUsageLogs.id))
    .where(and(...usageConditions(startDate, endDate)))
    .groupBy(periodExpr)
    .orderBy(desc(periodExpr))
    .limit(366);

  return rows.map((r) => ({
    ...r,
    marginCents: r.chargedCents - r.realCostCents,
    marginPct: computeMarginPct(r.realCostCents, r.chargedCents),
  }));
}

export async function getMarginByModel(
  startDate?: Date,
  endDate?: Date,
): Promise<MarginByModelRow[]> {
  const rows = await db
    .select({
      provider: aiUsageLogs.provider,
      model: aiUsageLogs.model,
      realCostCents: realCostSum,
      chargedCents: chargedSum,
      appliedCents: appliedSum,
      requestCount: count(),
    })
    .from(creditLedger)
    .leftJoin(aiUsageLogs, eq(creditLedger.aiUsageLogId, aiUsageLogs.id))
    .where(and(...usageConditions(startDate, endDate)))
    .groupBy(aiUsageLogs.provider, aiUsageLogs.model)
    .orderBy(desc(realCostSum))
    .limit(50);

  return rows.map((r) => ({
    ...r,
    provider: r.provider ?? 'unknown',
    model: r.model ?? 'unknown',
    marginCents: r.chargedCents - r.realCostCents,
    marginPct: computeMarginPct(r.realCostCents, r.chargedCents),
  }));
}

export async function getTopSpendersByMargin(
  startDate?: Date,
  endDate?: Date,
  limit = 10,
): Promise<TopSpenderRow[]> {
  const rows = await db
    .select({
      userId: creditLedger.userId,
      userName: users.name,
      userEmail: users.email,
      realCostCents: realCostSum,
      chargedCents: chargedSum,
      appliedCents: appliedSum,
      requestCount: count(),
    })
    .from(creditLedger)
    .leftJoin(aiUsageLogs, eq(creditLedger.aiUsageLogId, aiUsageLogs.id))
    .innerJoin(users, eq(creditLedger.userId, users.id))
    .where(and(...usageConditions(startDate, endDate)))
    .groupBy(creditLedger.userId, users.name, users.email)
    .orderBy(desc(chargedSum))
    .limit(limit);

  return (await decryptUserDisplayFields(rows)).map((r) => ({
    ...r,
    marginCents: r.chargedCents - r.realCostCents,
    marginPct: computeMarginPct(r.realCostCents, r.chargedCents),
  }));
}

export interface MarginByTierRow {
  tier: string;
  realCostCents: number;
  chargedCents: number;
  appliedCents: number;
  requestCount: number;
  marginCents: number;
  marginPct: number | null;
}

export async function getMarginByTier(
  startDate?: Date,
  endDate?: Date,
): Promise<MarginByTierRow[]> {
  const rows = await db
    .select({
      tier: users.subscriptionTier,
      realCostCents: realCostSum,
      chargedCents: chargedSum,
      appliedCents: appliedSum,
      requestCount: count(),
    })
    .from(creditLedger)
    .leftJoin(aiUsageLogs, eq(creditLedger.aiUsageLogId, aiUsageLogs.id))
    .innerJoin(users, eq(creditLedger.userId, users.id))
    .where(and(...usageConditions(startDate, endDate)))
    .groupBy(users.subscriptionTier)
    .orderBy(desc(realCostSum));

  return rows.map((r) => ({
    tier: r.tier ?? 'free',
    realCostCents: r.realCostCents,
    chargedCents: r.chargedCents,
    appliedCents: r.appliedCents,
    requestCount: r.requestCount,
    marginCents: r.chargedCents - r.realCostCents,
    marginPct: computeMarginPct(r.realCostCents, r.chargedCents),
  }));
}

export async function getOutstandingDebtByUser(limit = 10): Promise<DebtByUserRow[]> {
  const rows = await db
    .select({
      userId: creditBalances.userId,
      userName: users.name,
      userEmail: users.email,
      debtCents: creditBalances.debtCents,
    })
    .from(creditBalances)
    .innerJoin(users, eq(creditBalances.userId, users.id))
    .where(gt(creditBalances.debtCents, 0))
    .orderBy(desc(creditBalances.debtCents))
    .limit(limit);

  return (await decryptUserDisplayFields(rows)).map((r) => ({
    userId: r.userId,
    userName: r.userName,
    userEmail: r.userEmail,
    debtCents: r.debtCents,
  }));
}

export interface BalanceDriftRow {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  expectedSpendableCents: number;
  materializedSpendableCents: number;
  driftCents: number;
  debtCents: number;
}

export async function getBalanceDriftAlerts(
  toleranceCents: number = BALANCE_DRIFT_TOLERANCE_CENTS,
  limit = 50,
): Promise<BalanceDriftRow[]> {
  const rows = await db
    .select({
      userId: creditBalances.userId,
      userName: users.name,
      userEmail: users.email,
      materializedSpendableCents: sql<number>`(${creditBalances.monthlyRemainingCents} + ${creditBalances.topupRemainingCents})::int`,
      debtCents: creditBalances.debtCents,
      grantCents: sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.entryType} IN ('monthly_grant', 'topup_purchase') THEN ${creditLedger.amountCents} ELSE 0 END), 0)::int`,
      appliedUsageCents: sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.entryType} = 'usage' THEN ABS(${creditLedger.appliedCents}) ELSE 0 END), 0)::int`,
      adjustmentCents: sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.entryType} = 'adjustment' THEN COALESCE(${creditLedger.appliedCents}, 0) ELSE 0 END), 0)::int`,
    })
    .from(creditBalances)
    .innerJoin(users, eq(creditBalances.userId, users.id))
    .leftJoin(creditLedger, eq(creditLedger.userId, creditBalances.userId))
    .groupBy(
      creditBalances.userId,
      users.name,
      users.email,
      creditBalances.monthlyRemainingCents,
      creditBalances.topupRemainingCents,
      creditBalances.debtCents,
    );

  return (await decryptUserDisplayFields(rows))
    .map((r): BalanceDriftRow | null => {
      const drift = computeBalanceDrift(
        {
          grantCents: r.grantCents,
          appliedUsageCents: r.appliedUsageCents,
          adjustmentCents: r.adjustmentCents,
          materializedSpendableCents: r.materializedSpendableCents,
          debtCents: r.debtCents,
        },
        toleranceCents,
      );
      if (!drift.flagged) return null;
      return {
        userId: r.userId,
        userName: r.userName,
        userEmail: r.userEmail,
        expectedSpendableCents: drift.expectedSpendableCents,
        materializedSpendableCents: r.materializedSpendableCents,
        driftCents: drift.driftCents,
        debtCents: r.debtCents,
      };
    })
    .filter((r): r is BalanceDriftRow => r !== null)
    .sort((a, b) => Math.abs(b.driftCents) - Math.abs(a.driftCents))
    .slice(0, limit);
}

export interface NegativeMarginRow {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  realCostCents: number;
  chargedCents: number;
  marginCents: number;
  marginPct: number | null;
  requestCount: number;
}

export async function getNegativeMarginAccounts(
  startDate?: Date,
  endDate?: Date,
  marginFloorBps: number = NEGATIVE_MARGIN_FLOOR_BPS,
  limit = 50,
): Promise<NegativeMarginRow[]> {
  const floorBps = Math.max(0, marginFloorBps);
  const rows = await db
    .select({
      userId: creditLedger.userId,
      userName: users.name,
      userEmail: users.email,
      realCostCents: realCostSum,
      chargedCents: chargedSum,
      requestCount: count(),
    })
    .from(creditLedger)
    .leftJoin(aiUsageLogs, eq(creditLedger.aiUsageLogId, aiUsageLogs.id))
    .innerJoin(users, eq(creditLedger.userId, users.id))
    .where(and(...usageConditions(startDate, endDate)))
    .groupBy(creditLedger.userId, users.name, users.email)
    .having(sql`${realCostSum} > 0 AND ${chargedSum} < ${realCostSum} * (1 + ${floorBps}::numeric / 10000)`)
    .orderBy(asc(sql`${chargedSum} - ${realCostSum}`))
    .limit(limit);

  return (await decryptUserDisplayFields(rows))
    .filter((r) => isNegativeMargin(r.realCostCents, r.chargedCents, floorBps))
    .map((r) => ({
      ...r,
      marginCents: r.chargedCents - r.realCostCents,
      marginPct: computeMarginPct(r.realCostCents, r.chargedCents),
    }));
}

// ── AI billing panel queries ──────────────────────────────────────────────────

export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
}

export interface TokenUsageByModelRow extends TokenUsageTotals {
  provider: string;
  model: string;
}

export interface TokenUsageByPeriodRow extends TokenUsageTotals {
  period: string;
}

export interface TokenUsageByUserRow extends TokenUsageTotals {
  userId: string;
  userName: string | null;
  userEmail: string | null;
}

export type CostCoverage = 'real' | 'estimate' | 'list_price';

export interface ProviderCostRow {
  provider: string;
  model: string;
  coverage: CostCoverage;
  realCostCents: number;
  chargedCents: number;
  marginCents: number;
  marginPct: number | null;
  requestCount: number;
}

/**
 * Credit inflows split by kind. Deliberately has NO total: top-ups are real
 * cash revenue while monthly grants are plan allowances (including gifted and
 * free-tier users) — summing them overstates revenue.
 */
export interface CreditRevenue {
  /** Real cash: credits purchased via top-up. */
  topupCents: number;
  topupCount: number;
  /** Plan allowance grants — NOT cash revenue. */
  monthlyGrantCents: number;
  monthlyGrantCount: number;
}

export interface SubscriptionsByTierRow {
  tier: SubscriptionTier;
  count: number;
}

export interface CreditLiability {
  monthlyRemainingCents: number;
  topupRemainingCents: number;
  totalLiabilityCents: number;
  userCount: number;
}

export interface LiveHolds {
  holdCount: number;
  heldCents: number;
}

const inputTokenSum = sql<number>`COALESCE(SUM(${aiUsageLogs.inputTokens}), 0)::double precision`;
const outputTokenSum = sql<number>`COALESCE(SUM(${aiUsageLogs.outputTokens}), 0)::double precision`;
const totalTokenSum = sql<number>`COALESCE(SUM(${aiUsageLogs.totalTokens}), 0)::double precision`;

function tokenConditions(startDate?: Date, endDate?: Date): SQL[] {
  const conditions: SQL[] = [];
  if (startDate) conditions.push(gte(aiUsageLogs.timestamp, startDate));
  if (endDate) conditions.push(lte(aiUsageLogs.timestamp, endDate));
  return conditions;
}

function tokenWhere(startDate?: Date, endDate?: Date): SQL | undefined {
  const conditions = tokenConditions(startDate, endDate);
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function getTokenUsageSummary(
  startDate?: Date,
  endDate?: Date,
): Promise<TokenUsageTotals> {
  const rows = await db
    .select({
      inputTokens: inputTokenSum,
      outputTokens: outputTokenSum,
      totalTokens: totalTokenSum,
      requestCount: count(),
    })
    .from(aiUsageLogs)
    .where(tokenWhere(startDate, endDate));

  return {
    inputTokens: rows[0]?.inputTokens ?? 0,
    outputTokens: rows[0]?.outputTokens ?? 0,
    totalTokens: rows[0]?.totalTokens ?? 0,
    requestCount: rows[0]?.requestCount ?? 0,
  };
}

export async function getTokenUsageByModel(
  startDate?: Date,
  endDate?: Date,
  limit = 50,
): Promise<TokenUsageByModelRow[]> {
  const rows = await db
    .select({
      provider: aiUsageLogs.provider,
      model: aiUsageLogs.model,
      inputTokens: inputTokenSum,
      outputTokens: outputTokenSum,
      totalTokens: totalTokenSum,
      requestCount: count(),
    })
    .from(aiUsageLogs)
    .where(tokenWhere(startDate, endDate))
    .groupBy(aiUsageLogs.provider, aiUsageLogs.model)
    .orderBy(desc(totalTokenSum))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    provider: r.provider ?? 'unknown',
    model: r.model ?? 'unknown',
  }));
}

export async function getTokenUsageByPeriod(
  startDate?: Date,
  endDate?: Date,
  granularity: Granularity = 'day',
): Promise<TokenUsageByPeriodRow[]> {
  if (granularity !== 'day' && granularity !== 'month') {
    throw new Error(`Invalid granularity: ${granularity}`);
  }
  const periodExpr = sql<string>`DATE_TRUNC('${sql.raw(granularity)}', ${aiUsageLogs.timestamp})`;

  return db
    .select({
      period: periodExpr,
      inputTokens: inputTokenSum,
      outputTokens: outputTokenSum,
      totalTokens: totalTokenSum,
      requestCount: count(),
    })
    .from(aiUsageLogs)
    .where(tokenWhere(startDate, endDate))
    .groupBy(periodExpr)
    .orderBy(desc(periodExpr))
    .limit(366);
}

export async function getTokenUsageByUser(
  startDate?: Date,
  endDate?: Date,
  limit = 10,
): Promise<TokenUsageByUserRow[]> {
  const rows = await db
    .select({
      userId: aiUsageLogs.userId,
      userName: users.name,
      userEmail: users.email,
      inputTokens: inputTokenSum,
      outputTokens: outputTokenSum,
      totalTokens: totalTokenSum,
      requestCount: count(),
    })
    .from(aiUsageLogs)
    .innerJoin(users, eq(aiUsageLogs.userId, users.id))
    .where(tokenWhere(startDate, endDate))
    .groupBy(aiUsageLogs.userId, users.name, users.email)
    .orderBy(desc(totalTokenSum))
    .limit(limit);

  return decryptUserDisplayFields(rows);
}

export async function getProviderCostRollup(
  startDate?: Date,
  endDate?: Date,
): Promise<ProviderCostRow[]> {
  const costSourceExpr = sql<string | null>`${aiUsageLogs.metadata} ->> 'costSource'`;

  const rows = await db
    .select({
      provider: aiUsageLogs.provider,
      model: aiUsageLogs.model,
      costSource: costSourceExpr,
      realCostCents: realCostSum,
      chargedCents: chargedSum,
      requestCount: count(),
    })
    .from(creditLedger)
    .leftJoin(aiUsageLogs, eq(creditLedger.aiUsageLogId, aiUsageLogs.id))
    .where(and(...usageConditions(startDate, endDate)))
    .groupBy(aiUsageLogs.provider, aiUsageLogs.model, costSourceExpr)
    .orderBy(desc(realCostSum))
    .limit(50);

  return rows.map((r) => {
    const provider = r.provider ?? 'unknown';
    let coverage: CostCoverage;
    if (r.costSource === 'openrouter') coverage = 'real';
    else if (r.costSource === 'estimate') coverage = 'estimate';
    else if (r.costSource === 'list_price') coverage = 'list_price';
    else if (provider === 'openai_voice') coverage = 'list_price';
    else coverage = getBackendProvider(provider) === 'openrouter' ? 'real' : 'estimate';
    return {
      provider,
      model: r.model ?? 'unknown',
      coverage,
      realCostCents: r.realCostCents,
      chargedCents: r.chargedCents,
      marginCents: r.chargedCents - r.realCostCents,
      marginPct: computeMarginPct(r.realCostCents, r.chargedCents),
      requestCount: r.requestCount,
    };
  });
}

export async function getCreditRevenue(
  startDate?: Date,
  endDate?: Date,
): Promise<CreditRevenue> {
  const conditions: SQL[] = [inArray(creditLedger.entryType, ['topup_purchase', 'monthly_grant'])];
  if (startDate) conditions.push(gte(creditLedger.createdAt, startDate));
  if (endDate) conditions.push(lte(creditLedger.createdAt, endDate));

  const rows = await db
    .select({
      entryType: creditLedger.entryType,
      cents: sql<number>`COALESCE(SUM(${creditLedger.amountCents}), 0)::double precision`,
      count: count(),
    })
    .from(creditLedger)
    .where(and(...conditions))
    .groupBy(creditLedger.entryType);

  let topupCents = 0;
  let topupCount = 0;
  let monthlyGrantCents = 0;
  let monthlyGrantCount = 0;
  for (const r of rows) {
    if (r.entryType === 'topup_purchase') {
      topupCents = r.cents;
      topupCount = r.count;
    } else if (r.entryType === 'monthly_grant') {
      monthlyGrantCents = r.cents;
      monthlyGrantCount = r.count;
    }
  }

  return { topupCents, topupCount, monthlyGrantCents, monthlyGrantCount };
}

/**
 * Paying subscribers bucketed by tier. Consistent with the `payingUsers`
 * definition in getGrowthMetrics: status IN ('active', 'trialing') and
 * gifted = false. Legacy/grandfathered price IDs (absent from
 * STRIPE_PRICE_TO_TIER) are resolved by fetching their unit amount from
 * Stripe so getTierFromPrice's LEGACY_PRICE_AMOUNTS fallback applies instead
 * of miscounting real subscribers as 'free'.
 */
// Stripe prices are immutable once created, so resolved unit amounts are
// cached for the process lifetime. Failures are NOT cached so transient
// errors retry on the next load.
const legacyPriceAmountCache = new Map<string, number | null>();

export async function getActiveSubscriptionsByTier(): Promise<SubscriptionsByTierRow[]> {
  const rows = await db
    .select({ stripePriceId: subscriptions.stripePriceId })
    .from(subscriptions)
    .where(and(
      inArray(subscriptions.status, ['active', 'trialing']),
      eq(subscriptions.gifted, false),
    ));

  // Look up unit amounts for price IDs the static map doesn't know (one Stripe
  // call per distinct uncached legacy price ID, not per subscription row).
  const legacyPriceIds = [...new Set(rows.map((r) => r.stripePriceId))]
    .filter((priceId) => !(priceId in STRIPE_PRICE_TO_TIER));
  const amountByPriceId = new Map<string, number | null>();
  await Promise.all(legacyPriceIds.map(async (priceId) => {
    const cached = legacyPriceAmountCache.get(priceId);
    if (cached !== undefined) {
      amountByPriceId.set(priceId, cached);
      return;
    }
    try {
      const price = await stripe.prices.retrieve(priceId);
      legacyPriceAmountCache.set(priceId, price.unit_amount);
      amountByPriceId.set(priceId, price.unit_amount);
    } catch {
      // Unresolvable price (deleted in Stripe, network error) — falls back to
      // getTierFromPrice's 'free' bucket rather than failing the whole panel.
      amountByPriceId.set(priceId, null);
    }
  }));

  const counts = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<SubscriptionTier, number>;
  for (const r of rows) {
    counts[getTierFromPrice(r.stripePriceId, amountByPriceId.get(r.stripePriceId))] += 1;
  }

  return (Object.keys(counts) as SubscriptionTier[]).map((tier) => ({ tier, count: counts[tier] }));
}

export async function getCreditLiability(): Promise<CreditLiability> {
  const rows = await db
    .select({
      monthlyRemainingCents: sql<number>`COALESCE(SUM(${creditBalances.monthlyRemainingCents}), 0)::double precision`,
      topupRemainingCents: sql<number>`COALESCE(SUM(${creditBalances.topupRemainingCents}), 0)::double precision`,
      userCount: count(),
    })
    .from(creditBalances);

  const monthlyRemainingCents = rows[0]?.monthlyRemainingCents ?? 0;
  const topupRemainingCents = rows[0]?.topupRemainingCents ?? 0;
  return {
    monthlyRemainingCents,
    topupRemainingCents,
    totalLiabilityCents: monthlyRemainingCents + topupRemainingCents,
    userCount: rows[0]?.userCount ?? 0,
  };
}

export async function getLiveHolds(): Promise<LiveHolds> {
  const rows = await db
    .select({
      holdCount: count(),
      heldCents: sql<number>`COALESCE(SUM(${creditHolds.estCents}), 0)::double precision`,
    })
    .from(creditHolds)
    .where(sql`${creditHolds.expiresAt} > NOW()`);

  return {
    holdCount: rows[0]?.holdCount ?? 0,
    heldCents: rows[0]?.heldCents ?? 0,
  };
}

// ── Growth & MAU queries ──────────────────────────────────────────────────────

export interface GrowthSummary {
  totalUsers: number;
  mau: number;
  wau: number;
  dau: number;
  dauMauRatio: number;
  newUsersThisMonth: number;
  newUsersLastMonth: number;
  momGrowthPct: number | null;
  payingUsers: number;
  payingUsersPct: number;
}

export interface MAUTrendRow {
  period: string;
  mau: number;
  newUsers: number;
}

export interface DAUTrendRow {
  day: string;
  dau: number;
  signups: number;
}

export interface TierBreakdownRow {
  tier: string;
  count: number;
  pct: number;
}

export interface GrowthMetrics {
  summary: GrowthSummary;
  mauTrend: MAUTrendRow[];
  dauTrend: DAUTrendRow[];
  tierBreakdown: TierBreakdownRow[];
}

export async function getGrowthMetrics(): Promise<GrowthMetrics> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // Start of the month exactly 11 months ago → produces exactly 12 calendar months
  const twelveMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));

  const [totalUsersResult] = await db.select({ count: count() }).from(users);
  const totalUsers = totalUsersResult?.count ?? 0;

  // Current MAU/WAU/DAU from activity_logs — the ONE active-user definition for
  // all growth metrics (headline + trends). Sessions cannot serve any window
  // beyond ~2 weeks: they expire after 7 days and expired rows are hard-deleted
  // 7 days later (sessionService.cleanupExpiredSessions), so a sessions-based
  // 30d MAU or 12-month trend silently undercounts. activity_logs is retained
  // 365 days (activity-log-archival), covering every window used here.
  const [mauResult] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${activityLogs.userId})::int` })
    .from(activityLogs)
    .where(gte(activityLogs.timestamp, thirtyDaysAgo));

  const [wauResult] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${activityLogs.userId})::int` })
    .from(activityLogs)
    .where(gte(activityLogs.timestamp, sevenDaysAgo));

  const [dauResult] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${activityLogs.userId})::int` })
    .from(activityLogs)
    .where(gte(activityLogs.timestamp, oneDayAgo));

  const mau = mauResult?.count ?? 0;
  const wau = wauResult?.count ?? 0;
  const dau = dauResult?.count ?? 0;

  // Use rolling 30-day vs previous 30-day window to avoid partial-month bias.
  // Calendar-month comparison (current partial month vs full last month) systematically
  // shows negative growth before month-end — rolling windows are bias-free.
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const [newThisMonthResult] = await db
    .select({ count: count() })
    .from(users)
    .where(gte(users.createdAt, thirtyDaysAgo));

  const [newLastMonthResult] = await db
    .select({ count: count() })
    .from(users)
    .where(and(gte(users.createdAt, sixtyDaysAgo), lt(users.createdAt, thirtyDaysAgo)));

  const newUsersThisMonth = newThisMonthResult?.count ?? 0;
  const newUsersLastMonth = newLastMonthResult?.count ?? 0;
  const momGrowthPct = newUsersLastMonth > 0
    ? ((newUsersThisMonth - newUsersLastMonth) / newUsersLastMonth) * 100
    : null;

  const [payingResult] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${users.id})::int` })
    .from(users)
    .innerJoin(subscriptions, eq(subscriptions.userId, users.id))
    .where(and(
      inArray(subscriptions.status, ['active', 'trialing']),
      eq(subscriptions.gifted, false)
    ));
  const payingUsers = payingResult?.count ?? 0;

  // MAU trend (12 months). Same active-user definition as the headline
  // mau/wau/dau above: distinct activity_logs.userId bucketed by timestamp.
  // Trend and headline must reconcile — one definition, one durable source.
  const mauTrendRaw = await db
    .select({
      month: sql<string>`DATE_TRUNC('month', ${activityLogs.timestamp})`,
      mau: sql<number>`COUNT(DISTINCT ${activityLogs.userId})::int`,
    })
    .from(activityLogs)
    .where(gte(activityLogs.timestamp, twelveMonthsAgo))
    .groupBy(sql`DATE_TRUNC('month', ${activityLogs.timestamp})`)
    .orderBy(asc(sql`DATE_TRUNC('month', ${activityLogs.timestamp})`));

  const signupsByMonthRaw = await db
    .select({
      month: sql<string>`DATE_TRUNC('month', ${users.createdAt})`,
      signups: count(),
    })
    .from(users)
    .where(gte(users.createdAt, twelveMonthsAgo))
    .groupBy(sql`DATE_TRUNC('month', ${users.createdAt})`)
    .orderBy(asc(sql`DATE_TRUNC('month', ${users.createdAt})`));

  // DATE_TRUNC returns Date objects from the node-postgres driver despite the sql<string>
  // annotation — normalise to ISO strings so Map key equality works across queries.
  const toKey = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

  // Build exactly 12 fixed month buckets (UTC) ending at current month, ascending.
  const monthBucketKeys: string[] = Array.from({ length: 12 }, (_, i) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1)).toISOString()
  );
  const mauByMonth = new Map(mauTrendRaw.map(r => [toKey(r.month), r.mau]));
  const signupsByMonth = new Map(signupsByMonthRaw.map(r => [toKey(r.month), r.signups]));
  const mauTrend: MAUTrendRow[] = monthBucketKeys.map(key => ({
    period: key,
    mau: mauByMonth.get(key) ?? 0,
    newUsers: signupsByMonth.get(key) ?? 0,
  }));

  // DAU trend (last 30 days) — activity_logs, same definition as headline dau.
  const dauTrendRaw = await db
    .select({
      day: sql<string>`DATE_TRUNC('day', ${activityLogs.timestamp})`,
      dau: sql<number>`COUNT(DISTINCT ${activityLogs.userId})::int`,
    })
    .from(activityLogs)
    .where(gte(activityLogs.timestamp, thirtyDaysAgo))
    .groupBy(sql`DATE_TRUNC('day', ${activityLogs.timestamp})`)
    .orderBy(asc(sql`DATE_TRUNC('day', ${activityLogs.timestamp})`));

  const signupsByDayRaw = await db
    .select({
      day: sql<string>`DATE_TRUNC('day', ${users.createdAt})`,
      signups: count(),
    })
    .from(users)
    .where(gte(users.createdAt, thirtyDaysAgo))
    .groupBy(sql`DATE_TRUNC('day', ${users.createdAt})`)
    .orderBy(asc(sql`DATE_TRUNC('day', ${users.createdAt})`));

  // Build exactly 30 fixed day buckets (UTC) ending at yesterday, ascending.
  const dayBucketKeys: string[] = Array.from({ length: 30 }, (_, i) => {
    const msAgo = (29 - i) * 24 * 60 * 60 * 1000;
    const d = new Date(now.getTime() - msAgo);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  });
  const dauByDay = new Map(dauTrendRaw.map(r => [toKey(r.day), r.dau]));
  const signupsByDay = new Map(signupsByDayRaw.map(r => [toKey(r.day), r.signups]));
  const dauTrend: DAUTrendRow[] = dayBucketKeys.map(key => ({
    day: key,
    dau: dauByDay.get(key) ?? 0,
    signups: signupsByDay.get(key) ?? 0,
  }));

  // Tier breakdown
  const tierRaw = await db
    .select({ tier: users.subscriptionTier, count: count() })
    .from(users)
    .groupBy(users.subscriptionTier)
    .orderBy(desc(count()));

  const tierBreakdown: TierBreakdownRow[] = tierRaw.map(r => ({
    tier: r.tier,
    count: r.count,
    pct: totalUsers > 0 ? (r.count / totalUsers) * 100 : 0,
  }));

  return {
    summary: {
      totalUsers,
      mau,
      wau,
      dau,
      dauMauRatio: mau > 0 ? (dau / mau) * 100 : 0,
      newUsersThisMonth,
      newUsersLastMonth,
      momGrowthPct,
      payingUsers,
      payingUsersPct: totalUsers > 0 ? (payingUsers / totalUsers) * 100 : 0,
    },
    mauTrend,
    dauTrend,
    tierBreakdown,
  };
}