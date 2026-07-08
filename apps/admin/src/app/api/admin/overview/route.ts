import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { sql, and, gte, isNull, inArray, eq, count } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { sessions } from '@pagespace/db/schema/sessions';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { contactSubmissions } from '@pagespace/db/schema/contact';
import { withAdminAuth } from '@/lib/auth';
import { getApiMetrics, getUnitEconomicsSummary } from '@/lib/monitoring';
import { loggers } from '@pagespace/lib/logging/logger-config';

export interface OverviewSummary {
  totalUsers: number;
  newUsers7d: number;
  activeUsers15m: number;
  payingSubscribers: number;
  errorRate24h: number;
  openSupport: number;
  /** Last 30 days, cents. */
  realCostCents: number;
  chargedCents: number;
  marginPct: number | null;
}

export const GET = withAdminAuth(async () => {
  try {
    const now = Date.now();
    const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const since24h = new Date(now - 24 * 60 * 60 * 1000);
    const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const since15m = new Date(now - 15 * 60 * 1000);

    const [totalUsers, newUsers, activeUsers, paying, openSupport, apiMetrics, economics] = await Promise.all([
      db.select({ value: count() }).from(users),
      db.select({ value: count() }).from(users).where(gte(users.createdAt, since7d)),
      db.select({ value: sql<number>`COUNT(DISTINCT ${sessions.userId})::int` })
        .from(sessions)
        .where(and(gte(sessions.lastUsedAt, since15m), isNull(sessions.revokedAt))),
      db.select({ value: count() })
        .from(subscriptions)
        .where(and(inArray(subscriptions.status, ['active', 'trialing']), eq(subscriptions.gifted, false))),
      db.select({ value: count() }).from(contactSubmissions).where(isNull(contactSubmissions.resolvedAt)),
      getApiMetrics(since24h),
      getUnitEconomicsSummary(since30d, new Date(now)),
    ]);

    const summary: OverviewSummary = {
      totalUsers: totalUsers[0]?.value ?? 0,
      newUsers7d: newUsers[0]?.value ?? 0,
      activeUsers15m: activeUsers[0]?.value ?? 0,
      payingSubscribers: paying[0]?.value ?? 0,
      errorRate24h: apiMetrics.errorRate,
      openSupport: openSupport[0]?.value ?? 0,
      realCostCents: economics.realCostCents,
      chargedCents: economics.chargedCents,
      marginPct: economics.marginPct,
    };

    return NextResponse.json(summary, {
      headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=30' },
    });
  } catch (error) {
    loggers.api.error('Error fetching admin overview:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch overview' }, { status: 500 });
  }
});
