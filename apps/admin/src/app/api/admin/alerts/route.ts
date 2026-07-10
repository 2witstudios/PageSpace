import { NextResponse } from 'next/server';
import { getApiMetrics, getNegativeMarginAccounts, getLiveHolds } from '@/lib/monitoring';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { withAdminAuth } from '@/lib/auth/auth';

// Alert thresholds. Chosen as operational tripwires, not contractual SLOs.
// API error rate (%) over the last 24h above which the nav shows an error badge.
const ERROR_RATE_ALERT_PCT = 5;
// Any account with negative margin (24h window) is worth a look — alert on the first one.
const NEGATIVE_MARGIN_ALERT_COUNT = 1;
// Unexpired credit holds above this count suggest settle failures / stuck holds.
const LIVE_HOLDS_ALERT_COUNT = 50;

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
        errorRateAlert: metrics.errorRate > ERROR_RATE_ALERT_PCT,
        negativeMarginAlert: negativeMargin.length >= NEGATIVE_MARGIN_ALERT_COUNT,
        liveHoldsAlert: holds.holdCount > LIVE_HOLDS_ALERT_COUNT,
        errorRate: metrics.errorRate,
        negativeMarginCount: negativeMargin.length,
        liveHoldsCount: holds.holdCount,
      },
      // Authenticated admin data — private, never shared-cacheable.
      { headers: { 'Cache-Control': 'private, max-age=60, stale-while-revalidate=30' } }
    );
  } catch (error) {
    loggers.api.error('Error fetching admin alerts:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch alerts' }, { status: 500 });
  }
});
