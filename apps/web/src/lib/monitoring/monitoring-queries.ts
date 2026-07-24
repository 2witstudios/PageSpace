/**
 * Database queries for monitoring dashboard
 */

import { db } from '@pagespace/db/db'
import { getBackendProvider } from '@/lib/ai/core/ai-providers-config'
import { sql, eq, and, or, gt, gte, lte, asc, desc, count, inArray } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { apiMetrics, userActivities, aiUsageLogs, systemLogs, errorLogs } from '@pagespace/db/schema/monitoring';
import { creditLedger, creditBalances, creditHolds } from '@pagespace/db/schema/credits';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import type { SQL } from '@pagespace/db/operators';
import { decryptUserDisplayFields } from '@pagespace/lib/auth/user-repository';
import { computeBalanceDrift, isNegativeMargin } from '@pagespace/lib/billing/credit-core';
import { BALANCE_DRIFT_TOLERANCE_CENTS, NEGATIVE_MARGIN_FLOOR_BPS } from '@pagespace/lib/billing/credit-pricing';
import { getTierFromPrice } from '@/lib/stripe/price-config';
import { TIERS, type SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
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
  getActivityHeatmap as chGetActivityHeatmap,
  getMostActiveUsers as chGetMostActiveUsers,
  getFeatureUsage as chGetFeatureUsage,
  getActiveUserCount as chGetActiveUserCount,
  getResponseTimes as chGetResponseTimes,
  getSlowQueries as chGetSlowQueries,
  getEndpointPerformance as chGetEndpointPerformance,
} from '@pagespace/lib/observability/analytics-reads';
import type { ClickHouseClient } from '@pagespace/lib/observability/clickhouse-client';

/**
 * Post-cutover (#890 Phase 3) new analytics rows land only in ClickHouse, so
 * the readers over the 4 moved tables (apiMetrics, systemLogs,
 * userActivities, errorLogs) query CH when the flag is on — server-side
 * only (never from a browser bundle; next.config aliases '@clickhouse/client'
 * to false for browser builds), aggregations in CH SQL — and hit PG exactly
 * as before when the flag is off. Returns null when the tier is off so
 * callers fall through to the PG path. Anything that JOINed the moved tables
 * to users converts to a two-step lookup (fetch CH rows → fetch users by id
 * from PG → merge in app code); CH and PG are never SQL-joined.
 */
function clickHouseClientIfEnabled(): ClickHouseClient | null {
  return isClickHouseEnabled() ? getClickHouseClient() : null;
}

/**
 * Over-fetch factor for the two-step most-active-users lookup: activity rows
 * whose user has since been deleted have no users row — the PG path's INNER
 * JOIN silently drops them, so the CH path fetches extra ranks and drops
 * misses after the lookup to keep the top-10 comparable.
 */
const MOST_ACTIVE_USERS_OVERFETCH = 100;

/**
 * Get system health overview
 */
export async function getSystemHealth(startDate?: Date, endDate?: Date) {
  const chClient = clickHouseClientIfEnabled();
  if (chClient) {
    const window = { startDate, endDate };
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const [logsByLevel, recentErrors, activeUserCount] = await Promise.all([
      chGetLogsByLevel(chClient, window),
      chGetRecentErrors(chClient, window, 20),
      chGetActiveUserCount(chClient, fifteenMinutesAgo),
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

  // Get active users in last 15 minutes for the summary card
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
  const activeUsers = await db
    .select({
      count: sql<number>`COUNT(DISTINCT ${userActivities.userId})::int`,
    })
    .from(userActivities)
    .where(gte(userActivities.timestamp, fifteenMinutesAgo));

  return {
    logsByLevel: logsByLevel.map((entry) => ({
      level: entry.level,
      count: entry.count,
    })),
    recentErrors: recentErrors.map((entry) => ({
      ...entry,
      errorMessage: entry.errorMessage || entry.message,
    })),
    activeUserCount: activeUsers[0]?.count || 0,
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
 */
export async function getUserActivity(startDate?: Date, endDate?: Date) {
  const chClient = clickHouseClientIfEnabled();
  if (chClient) {
    const window = { startDate, endDate };
    const [heatmapData, activeUserCounts, featureUsage] = await Promise.all([
      chGetActivityHeatmap(chClient, window),
      chGetMostActiveUsers(chClient, window, MOST_ACTIVE_USERS_OVERFETCH),
      chGetFeatureUsage(chClient, window),
    ]);

    // Two-step cross-store join: user names come from main PG by id.
    const userIds = activeUserCounts.map((row) => row.userId);
    const userRows = userIds.length > 0
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];
    const nameById = new Map(userRows.map((u) => [u.id, u.name]));
    const mostActiveUsers = activeUserCounts
      .filter((row) => nameById.has(row.userId))
      .slice(0, 10)
      .map((row) => ({
        userId: row.userId,
        userName: nameById.get(row.userId) ?? null,
        actionCount: row.actionCount,
      }));

    return {
      heatmapData,
      mostActiveUsers: await decryptUserDisplayFields(mostActiveUsers),
      featureUsage,
    };
  }

  const conditions = [];

  if (startDate) {
    conditions.push(gte(userActivities.timestamp, startDate));
  }
  if (endDate) {
    conditions.push(lte(userActivities.timestamp, endDate));
  }

  // Get activity heatmap data - using Drizzle query
  const heatmapData = await db
    .select({
      day_of_week: sql<number>`EXTRACT(DOW FROM ${userActivities.timestamp})`,
      hour_of_day: sql<number>`EXTRACT(HOUR FROM ${userActivities.timestamp})`,
      activity_count: count(),
    })
    .from(userActivities)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(
      sql`EXTRACT(DOW FROM ${userActivities.timestamp})`,
      sql`EXTRACT(HOUR FROM ${userActivities.timestamp})`
    );

  // Get most active users
  const mostActiveUsers = await db
    .select({
      userId: userActivities.userId,
      userName: users.name,
      actionCount: count(),
    })
    .from(userActivities)
    .innerJoin(users, eq(userActivities.userId, users.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(userActivities.userId, users.name)
    .orderBy(desc(count()))
    .limit(10);

  // Get feature usage
  const featureUsage = await db
    .select({
      action: userActivities.action,
      count: count(),
    })
    .from(userActivities)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(userActivities.action)
    .orderBy(desc(count()))
    .limit(15);

  return {
    heatmapData,
    mostActiveUsers: await decryptUserDisplayFields(mostActiveUsers),
    featureUsage,
  };
}

/**
 * Get AI usage metrics
 */
export async function getAiUsageMetrics(startDate?: Date, endDate?: Date) {
  const conditions = [];
  
  if (startDate) {
    conditions.push(gte(aiUsageLogs.timestamp, startDate));
  }
  if (endDate) {
    conditions.push(lte(aiUsageLogs.timestamp, endDate));
  }

  // Get costs by provider
  const costsByProvider = await db
    .select({
      provider: aiUsageLogs.provider,
      totalCost: sql<number>`SUM(COALESCE(${aiUsageLogs.cost}, 0))`,
      requestCount: count(),
    })
    .from(aiUsageLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(aiUsageLogs.provider);

  // Get token usage over time - using Drizzle query
  const tokenUsageOverTime = await db
    .select({
      day: sql<string>`DATE_TRUNC('day', ${aiUsageLogs.timestamp})`,
      total_tokens: sql<number>`SUM(COALESCE(${aiUsageLogs.totalTokens}, 0))`,
      total_cost: sql<number>`SUM(COALESCE(${aiUsageLogs.cost}, 0))`,
    })
    .from(aiUsageLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(sql`DATE_TRUNC('day', ${aiUsageLogs.timestamp})`)
    .orderBy(desc(sql`DATE_TRUNC('day', ${aiUsageLogs.timestamp})`))
    .limit(30);

  // Get model popularity
  const modelPopularity = await db
    .select({
      model: aiUsageLogs.model,
      usageCount: count(),
      totalTokens: sql<number>`SUM(COALESCE(${aiUsageLogs.totalTokens}, 0))`,
    })
    .from(aiUsageLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(aiUsageLogs.model)
    .orderBy(desc(count()))
    .limit(10);

  // Get success/failure rates
  const successCount = await db
    .select({ count: count() })
    .from(aiUsageLogs)
    .where(and(
      eq(aiUsageLogs.success, true),
      ...(conditions.length > 0 ? conditions : [])
    ));

  const totalCount = await db
    .select({ count: count() })
    .from(aiUsageLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const successRate = totalCount[0]?.count > 0
    ? (successCount[0]?.count / totalCount[0]?.count) * 100
    : 0;

  // Get top spending users
  const topSpenders = await db
    .select({
      userId: aiUsageLogs.userId,
      userName: users.name,
      totalCost: sql<number>`SUM(COALESCE(${aiUsageLogs.cost}, 0))`,
      requestCount: count(),
    })
    .from(aiUsageLogs)
    .innerJoin(users, eq(aiUsageLogs.userId, users.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(aiUsageLogs.userId, users.name)
    .orderBy(desc(sql`SUM(COALESCE(${aiUsageLogs.cost}, 0))`))
    .limit(5);

  return {
    costsByProvider,
    tokenUsageOverTime,
    modelPopularity,
    successRate,
    topSpenders: await decryptUserDisplayFields(topSpenders),
  };
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
        metadata: login.metadata,
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
      metadata: login.metadata as Record<string, unknown> | null,
    })),
  };
}

/**
 * Get performance metrics
 */
export async function getPerformanceMetrics(startDate?: Date, endDate?: Date) {
  const chClient = clickHouseClientIfEnabled();
  if (chClient) {
    const window = { startDate, endDate };
    const [responseTimes, slowQueries, metricTypes] = await Promise.all([
      chGetResponseTimes(chClient, window),
      chGetSlowQueries(chClient, window),
      chGetEndpointPerformance(chClient, window),
    ]);
    return { responseTimes, slowQueries, metricTypes };
  }

  const conditions = [];

  if (startDate) {
    conditions.push(gte(apiMetrics.timestamp, startDate));
  }
  if (endDate) {
    conditions.push(lte(apiMetrics.timestamp, endDate));
  }

  // Get average response times - using Drizzle query
  const responseTimes = await db
    .select({
      hour: sql<string>`DATE_TRUNC('hour', ${apiMetrics.timestamp})`,
      avg_response_time: sql<number>`AVG(${apiMetrics.duration})`,
      max_response_time: sql<number>`MAX(${apiMetrics.duration})`,
      min_response_time: sql<number>`MIN(${apiMetrics.duration})`,
    })
    .from(apiMetrics)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(sql`DATE_TRUNC('hour', ${apiMetrics.timestamp})`)
    .orderBy(desc(sql`DATE_TRUNC('hour', ${apiMetrics.timestamp})`))
    .limit(48);

  // Get slow queries
  const slowQueries = await db
    .select({
      endpoint: apiMetrics.endpoint,
      responseTime: apiMetrics.duration,
      timestamp: apiMetrics.timestamp,
      userId: apiMetrics.userId,
    })
    .from(apiMetrics)
    .where(and(
      gte(apiMetrics.duration, 5000), // > 5 seconds
      ...(conditions.length > 0 ? conditions : [])
    ))
    .orderBy(desc(apiMetrics.duration))
    .limit(20);

  // Get performance by endpoint
  const metricTypes = await db
    .select({
      metric: apiMetrics.endpoint,
      avgValue: sql<number>`AVG(${apiMetrics.duration})`,
      count: count(),
    })
    .from(apiMetrics)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(apiMetrics.endpoint)
    .orderBy(desc(count()));

  return {
    responseTimes,
    slowQueries,
    metricTypes,
  };
}

// ── AI unit economics (real cost vs charged credits vs margin) ────────────────
//
// The metering data already exists; these queries only aggregate it:
//   - creditLedger.realCostCents   — our REAL provider cost, pre-markup (cents)
//   - creditLedger.amountCents      — full intended charge to the user (signed)
//   - creditLedger.appliedCents     — actually debited from the balance (signed)
//   - credit_balances.debtCents     — CURRENT outstanding overage (point-in-time). NOT
//                                     the historical 'adjustment' ledger rows: debt is
//                                     repaid by top-ups and forgiven at renewal directly
//                                     on debtCents, so only the live balance is accurate.
// Each AI call has exactly one entryType='usage' ledger row, soft-linked to its
// aiUsageLogs row via aiUsageLogId, so a join reaches provider/model/timestamp.
// All magnitudes are taken as ABS() because usage/debt rows store negative values.

export type Granularity = 'day' | 'month';

export interface UnitEconomicsSummary {
  realCostCents: number;
  chargedCents: number;
  appliedCents: number;
  requestCount: number;
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

/**
 * Gross margin as a percentage of real cost: (charged − real) / real × 100.
 * Returns null when real cost is non-positive, since the percentage is then
 * undefined (a charge against zero cost is infinite margin, not a number).
 */
export function computeMarginPct(realCostCents: number, chargedCents: number): number | null {
  if (!realCostCents || realCostCents <= 0) return null;
  return ((chargedCents - realCostCents) / realCostCents) * 100;
}

// Reusable SQL aggregate expressions over the ledger usage rows.
//
// IMPORTANT (sub-cent accuracy): a single cheap-model call can cost a fraction
// of a cent. The ledger stores the PRECISE charge in `chargeMillicents`
// (1/1000 cent) and the precise real cost lives in `aiUsageLogs.cost` (dollars);
// the whole-cent `amountCents`/`realCostCents` columns are per-row rounded for
// audit. Summing the rounded columns would round high-volume sub-cent traffic to
// $0 and report a bogus margin — so we SUM the precise fields and round ONCE at
// the end. `appliedCents` is exempt: it is the whole-cent amount actually debited
// (the sub-cent remainder is banked in pendingMillicents), so its sum is exact.
//
// PURGE FALLBACK: `aiUsageLogs` is reaped on retention while its ledger row
// survives. For those rows `aiUsageLogs.cost` is NULL, so we fall back per-row to
// the ledger's preserved `realCostCents` audit value (already whole-cent). Without
// this, an `?range=all` window would silently count purged traffic as $0 real cost
// and overstate margin. `SUM(cost)*100 === SUM(cost*100)`, so live rows are
// unchanged; only purged rows newly contribute their retained cost.
const realCostSum = sql<number>`ROUND(COALESCE(SUM(
  CASE
    WHEN ${aiUsageLogs.cost} IS NOT NULL THEN ${aiUsageLogs.cost}::numeric * 100
    ELSE ${creditLedger.realCostCents}
  END
), 0))::int`;
const chargedSum = sql<number>`ROUND(COALESCE(SUM(COALESCE(${creditLedger.chargeMillicents}, ABS(${creditLedger.amountCents}) * 1000)), 0) / 1000.0)::int`;
const appliedSum = sql<number>`COALESCE(SUM(ABS(${creditLedger.appliedCents})), 0)::int`;

// Usage-row conditions: entryType='usage' plus optional time range.
//
// The window is anchored on the ledger's OWN `createdAt`, never on
// `aiUsageLogs.timestamp`. The aiUsageLog is a soft link that can be purged on
// retention; filtering (or grouping/joining) on its timestamp would drop the
// surviving ledger row from these aggregates and silently under-report charged
// credits and margin. The ledger is the source of truth for what we billed, so we
// LEFT JOIN aiUsageLogs only to enrich real provider cost when it's still present.
function usageConditions(startDate?: Date, endDate?: Date): SQL[] {
  const conditions: SQL[] = [eq(creditLedger.entryType, 'usage')];
  if (startDate) conditions.push(gte(creditLedger.createdAt, startDate));
  if (endDate) conditions.push(lte(creditLedger.createdAt, endDate));
  return conditions;
}

/**
 * Total real cost vs charged credits, gross margin, request count, and
 * uncovered debt across the period.
 */
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

  // Outstanding debt is the CURRENT liability — a point-in-time snapshot of the live
  // credit_balances.debtCents, NOT a sum of historical 'adjustment' incurrence rows.
  // Debt is paid down by top-ups and forgiven at renewal directly on debtCents without
  // offsetting ledger rows, so summing adjustment history would keep counting overage
  // the user has already repaid or had forgiven. Period-independent (like the prepaid
  // liability metric); the start/end window scopes the usage flows above, not this stock.
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

/**
 * Margin per period (day or month) over the requested window.
 */
export async function getMarginByPeriod(
  startDate?: Date,
  endDate?: Date,
  granularity: Granularity = 'day',
): Promise<MarginByPeriodRow[]> {
  if (granularity !== 'day' && granularity !== 'month') {
    throw new Error(`Invalid granularity: ${granularity}`);
  }
  // Bucket on the ledger's own createdAt (not the purgeable aiUsageLogs.timestamp),
  // so a row whose usage log was reaped still lands in the right period. Bound
  // parameter, not string interpolation — DATE_TRUNC's unit is a value.
  const periodExpr = sql<string>`DATE_TRUNC(${granularity}, ${creditLedger.createdAt})`;

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

/**
 * Margin per provider/model — surfaces which models earn or lose money.
 */
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

  // provider/model are null for ledger rows whose usage log was purged — bucket
  // those under 'unknown' rather than dropping their charged credits.
  return rows.map((r) => ({
    ...r,
    provider: r.provider ?? 'unknown',
    model: r.model ?? 'unknown',
    marginCents: r.chargedCents - r.realCostCents,
    marginPct: computeMarginPct(r.realCostCents, r.chargedCents),
  }));
}

/**
 * Top spenders by charged credits, with their real cost and margin.
 */
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

  return decryptUserDisplayFields(
    rows.map((r) => ({
      ...r,
      marginCents: r.chargedCents - r.realCostCents,
      marginPct: computeMarginPct(r.realCostCents, r.chargedCents),
    })),
  );
}

/**
 * Users currently carrying outstanding overage — a point-in-time snapshot of the live
 * credit_balances.debtCents (NOT historical 'adjustment' rows, which would still count
 * debt already repaid by a top-up or forgiven at renewal). Period-independent.
 */
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

  return decryptUserDisplayFields(
    rows.map((r) => ({
      userId: r.userId,
      userName: r.userName,
      userEmail: r.userEmail,
      debtCents: r.debtCents,
    })),
  );
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

/**
 * Accounts whose MATERIALIZED spendable buckets diverge from the ledger-implied amount
 * beyond tolerance — a drift smell detector for the admin panel (see computeBalanceDrift;
 * rollover carry-forwards / debt-forgiveness make this approximate, hence a generous
 * tolerance; with rollover there are no silent per-period drops to explain away).
 * Aggregates the whole ledger per user (drift is a stock, not a period flow), joins the
 * live balance, and returns only flagged rows, worst drift first.
 */
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

  const flagged = rows
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

  return decryptUserDisplayFields(flagged);
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

/**
 * Accounts where charged credits fail to cover real provider cost by the margin floor —
 * i.e. we're (near-)losing money on them. Per-user usage aggregates over the window,
 * filtered by isNegativeMargin, worst (most negative) margin first.
 */
export async function getNegativeMarginAccounts(
  startDate?: Date,
  endDate?: Date,
  marginFloorBps: number = NEGATIVE_MARGIN_FLOOR_BPS,
  limit = 50,
): Promise<NegativeMarginRow[]> {
  // Clamp once so the SQL HAVING and the JS isNegativeMargin re-check agree. isNegativeMargin
  // floors negative bps to 0; if the raw value reached the SQL filter, a negative override
  // could drop rows the JS check would still flag (silent false negatives).
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

  // Re-assert the predicate with the shared pure helper so the panel and the SQL filter
  // can never silently disagree.
  return decryptUserDisplayFields(
    rows
      .filter((r) => isNegativeMargin(r.realCostCents, r.chargedCents, floorBps))
      .map((r) => ({
        ...r,
        marginCents: r.chargedCents - r.realCostCents,
        marginPct: computeMarginPct(r.realCostCents, r.chargedCents),
      })),
  );
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

// ---------------------------------------------------------------------------
// AI-billing admin panel queries
//
// A dedicated operational view (separate from unit-economics' margin focus):
// raw token volume, provider cost coverage (real vs estimated), Stripe revenue,
// and point-in-time credit liability + live holds. Reuses the same precise
// sub-cent summing and createdAt anchoring as the margin queries above.
// ---------------------------------------------------------------------------

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

export interface CreditRevenue {
  topupCents: number;
  topupCount: number;
  monthlyGrantCents: number;
  monthlyGrantCount: number;
  totalCents: number;
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

// Token sums use double precision (not ::int) so high-volume windows can't
// overflow int4 (~2.1B); tokens are display-only so float8's 53-bit mantissa is
// ample. Token usage is inherently a usage-LOG view, so these anchor on
// aiUsageLogs.timestamp (unlike the ledger-anchored margin queries).
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

/** SUM of input/output/total tokens and request count across the window. */
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

/** Token volume grouped by provider/model, busiest first. */
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

/** Token volume per day/month over the window. */
export async function getTokenUsageByPeriod(
  startDate?: Date,
  endDate?: Date,
  granularity: Granularity = 'day',
): Promise<TokenUsageByPeriodRow[]> {
  if (granularity !== 'day' && granularity !== 'month') {
    throw new Error(`Invalid granularity: ${granularity}`);
  }
  const periodExpr = sql<string>`DATE_TRUNC(${granularity}, ${aiUsageLogs.timestamp})`;

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

/** Token volume per user, heaviest first. */
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

/**
 * What we pay providers, grouped by provider/model AND billing basis, from the
 * real cost now flowing into the ledger. `coverage` is the EXACT per-row basis,
 * read from `aiUsageLogs.metadata.costSource` that trackAIUsage stamps:
 * 'openrouter' (real returned cost) → 'real', 'estimate' (static fallback) →
 * 'estimate'. This is honest even when an OpenRouter call fell back to the
 * estimate (missing cost metadata) — that row reports 'estimate', not 'real'.
 * For rows whose usage log was purged (metadata gone) we best-effort fall back
 * to the provider name. Anchored on the ledger's createdAt; the usage-log join
 * only enriches provider/model/costSource.
 */
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
    // Voice (STT/TTS): cost is deterministic exact-quantity × published OpenAI rate,
    // not a live provider-returned figure (real) nor a token-guess fallback (estimate).
    else if (r.costSource === 'list_price') coverage = 'list_price';
    // metadata purged: fall back to the provider-name heuristic. Direct voice
    // (openai_voice) always bills on exact list price, so retain that coverage even
    // after metadata retention strips costSource — otherwise purged STT/TTS rows are
    // mislabeled 'estimate' (openai_voice is not OpenRouter-backed). Cloud vendors are
    // OpenRouter-backed → real; local providers → estimate.
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

/**
 * Stripe-sourced credit revenue over the window: top-up purchases and monthly
 * grants. Both carry the positive credit value in `amountCents`; summed from the
 * ledger anchored on createdAt.
 */
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

  return {
    topupCents,
    topupCount,
    monthlyGrantCents,
    monthlyGrantCount,
    totalCents: topupCents + monthlyGrantCents,
  };
}

/**
 * Active subscriptions counted by tier. Tier is derived from the Stripe price id
 * via the authoritative price→tier map (the subscriptions table stores only the
 * price id), aggregated in JS.
 */
export async function getActiveSubscriptionsByTier(): Promise<SubscriptionsByTierRow[]> {
  const rows = await db
    .select({ stripePriceId: subscriptions.stripePriceId })
    .from(subscriptions)
    .where(eq(subscriptions.status, 'active'));

  const counts = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<SubscriptionTier, number>;
  for (const r of rows) {
    counts[getTierFromPrice(r.stripePriceId)] += 1;
  }

  return (Object.keys(counts) as SubscriptionTier[]).map((tier) => ({ tier, count: counts[tier] }));
}

/**
 * Outstanding prepaid liability: the sum of every user's spendable balance
 * (monthly + top-up remaining) — credit value we owe service against.
 * Point-in-time, not windowed.
 */
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

/**
 * Live in-flight credit holds (reservations placed by the gate not yet settled
 * or expired). NOW()-relative so it matches what the gate actually subtracts.
 */
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
