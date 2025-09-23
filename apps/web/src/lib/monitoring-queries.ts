/**
 * Database queries for monitoring dashboard
 */

import {
  db,
  apiMetrics,
  userActivities,
  aiUsageLogs,
  systemLogs,
  errorLogs,
  sql,
  eq,
  and,
  or,
  gte,
  lte,
  desc,
  count
} from '@pagespace/db';
import type { SQL } from 'drizzle-orm';

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

  const errorConditions: SQL[] = [...logConditions];

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

  const userConditions: SQL[] = [];

  if (startDate) {
    userConditions.push(gte(userActivities.timestamp, startDate));
  }
  if (endDate) {
    userConditions.push(lte(userActivities.timestamp, endDate));
  }

  const activeUsers = await db
    .select({
      count: sql<number>`COUNT(DISTINCT ${userActivities.userId})::int`,
    })
    .from(userActivities)
    .where(userConditions.length > 0 ? and(...userConditions) : undefined);

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
 */
export async function getUserActivity(startDate?: Date, endDate?: Date) {
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
      actionCount: count(),
    })
    .from(userActivities)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(userActivities.userId)
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
      totalCost: sql<number>`SUM(COALESCE(${aiUsageLogs.cost}, 0))`,
      requestCount: count(),
    })
    .from(aiUsageLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(aiUsageLogs.userId)
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
    or(eq(systemLogs.level, 'warn' as const), eq(systemLogs.level, 'error' as const)),
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

  // Get performance by endpoint (using apiMetrics instead of performanceMetrics)
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