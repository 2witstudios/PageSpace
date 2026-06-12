/**
 * Database queries for monitoring dashboard
 */

import { db } from '@pagespace/db/db'
import { sql, eq, and, or, gt, asc, gte, lte, lt, desc, count, inArray, isNull, isNotNull } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { apiMetrics, userActivities, aiUsageLogs, systemLogs, errorLogs, activityLogs } from '@pagespace/db/schema/monitoring';
import { sessions } from '@pagespace/db/schema/sessions';
import { creditLedger, creditBalances, creditHolds } from '@pagespace/db/schema/credits';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import type { SQL } from '@pagespace/db/operators';
import { computeBalanceDrift, isNegativeMargin } from '@pagespace/lib/billing/credit-core';
import { BALANCE_DRIFT_TOLERANCE_CENTS, NEGATIVE_MARGIN_FLOOR_BPS } from '@pagespace/lib/billing/credit-pricing';
import { getTierFromPrice } from './stripe/price-config';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';

/**
 * Get system health overview
 */
export async function getSystemHealth(startDate?: Date, endDate?: Date) {
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
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
  const activeUsers = await db
    .select({
      count: sql<number>`COUNT(DISTINCT ${sessions.userId})::int`,
    })
    .from(sessions)
    .where(and(gte(sessions.lastUsedAt, fifteenMinutesAgo), isNull(sessions.revokedAt)));

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
    mostActiveUsers,
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
    topSpenders,
  };
}

/**
 * Get error analytics
 */
export async function getErrorAnalytics(startDate?: Date, endDate?: Date) {
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

  return rows.map((r) => ({
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

  return rows.map((r) => ({
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

  return rows
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

  return rows
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
  return db
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

  return { topupCents, topupCount, monthlyGrantCents, monthlyGrantCount, totalCents: topupCents + monthlyGrantCents };
}

export async function getActiveSubscriptionsByTier(): Promise<SubscriptionsByTierRow[]> {
  const rows = await db
    .select({ stripePriceId: subscriptions.stripePriceId })
    .from(subscriptions)
    .where(eq(subscriptions.status, 'active'));

  const counts: Record<SubscriptionTier, number> = { free: 0, pro: 0, founder: 0, business: 0 };
  for (const r of rows) {
    counts[getTierFromPrice(r.stripePriceId)] += 1;
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
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const twelveMonthsAgo = new Date(now.getFullYear() - 1, now.getMonth(), 1);

  const [totalUsersResult] = await db.select({ count: count() }).from(users);
  const totalUsers = totalUsersResult?.count ?? 0;

  // Current MAU/WAU/DAU from session activity — count ALL sessions with lastUsedAt in
  // the window, regardless of revokedAt. A user who was active 15 days ago and then logged
  // out still counts toward MAU; revokedAt describes current session state, not history.
  const [mauResult] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${sessions.userId})::int` })
    .from(sessions)
    .where(gte(sessions.lastUsedAt, thirtyDaysAgo));

  const [wauResult] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${sessions.userId})::int` })
    .from(sessions)
    .where(gte(sessions.lastUsedAt, sevenDaysAgo));

  const [dauResult] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${sessions.userId})::int` })
    .from(sessions)
    .where(gte(sessions.lastUsedAt, oneDayAgo));

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
    .select({ count: count() })
    .from(users)
    .where(sql`${users.subscriptionTier} != 'free'`);
  const payingUsers = payingResult?.count ?? 0;

  // MAU trend (12 months) from activity_logs — comprehensive audit trail
  const mauTrendRaw = await db
    .select({
      month: sql<string>`DATE_TRUNC('month', ${activityLogs.timestamp})`,
      mau: sql<number>`COUNT(DISTINCT ${activityLogs.userId})::int`,
    })
    .from(activityLogs)
    .where(and(gte(activityLogs.timestamp, twelveMonthsAgo), isNotNull(activityLogs.userId)))
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
  const signupsByMonth = new Map(signupsByMonthRaw.map(r => [toKey(r.month), r.signups]));
  const mauTrend: MAUTrendRow[] = mauTrendRaw.map(r => ({
    period: toKey(r.month),
    mau: r.mau,
    newUsers: signupsByMonth.get(toKey(r.month)) ?? 0,
  }));

  // DAU trend (last 30 days) from activity_logs
  const dauTrendRaw = await db
    .select({
      day: sql<string>`DATE_TRUNC('day', ${activityLogs.timestamp})`,
      dau: sql<number>`COUNT(DISTINCT ${activityLogs.userId})::int`,
    })
    .from(activityLogs)
    .where(and(gte(activityLogs.timestamp, thirtyDaysAgo), isNotNull(activityLogs.userId)))
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

  const signupsByDay = new Map(signupsByDayRaw.map(r => [toKey(r.day), r.signups]));
  const dauTrend: DAUTrendRow[] = dauTrendRaw.map(r => ({
    day: toKey(r.day),
    dau: r.dau,
    signups: signupsByDay.get(toKey(r.day)) ?? 0,
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