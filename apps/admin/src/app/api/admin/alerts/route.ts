import { NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/auth';
import { getApiMetrics, getNegativeMarginAccounts, getLiveHolds } from '@/lib/monitoring';
import { loggers } from '@pagespace/lib/logging/logger-config';

// Lightweight alert-state endpoint for nav badges. Cached 60s.
export const GET = withAdminAuth(async () => {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [metrics, negativeMargin, holds] = await Promise.all([
      getApiMetrics(since24h),
      getNegativeMarginAccounts(since24h),
      getLiveHolds(),
    ]);

    return NextResponse.json(
      {
        errorRateAlert: metrics.errorRate > 5,
        negativeMarginAlert: negativeMargin.length > 0,
        liveHoldsAlert: holds.holdCount > 50,
        errorRate: metrics.errorRate,
        negativeMarginCount: negativeMargin.length,
        liveHoldsCount: holds.holdCount,
      },
      { headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=30' } }
    );
  } catch (error) {
    loggers.api.error('Error fetching admin alerts:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch alerts' }, { status: 500 });
  }
});
