import { anonymizeAiUsageContent, purgeAiUsageLogs } from '@pagespace/lib';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to anonymize and purge old AI usage logs.
 *
 * Two-phase approach:
 * 1. Anonymize prompt/completion text for logs older than 30 days
 * 2. Purge entire rows older than 90 days
 *
 * This preserves recent analytics while enforcing data retention limits.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature headers.
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const anonymized = await anonymizeAiUsageContent(thirtyDaysAgo);
    const purged = await purgeAiUsageLogs(ninetyDaysAgo);

    console.log(`[Cron] AI usage logs: anonymized ${anonymized}, purged ${purged}`);

    return NextResponse.json({
      success: true,
      anonymized,
      purged,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Error purging AI usage logs:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
