import { purgeAiUsageLogs } from '@pagespace/lib';
import { audit } from '@pagespace/lib/server';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to purge old AI usage logs.
 *
 * Deletes entire rows older than 90 days to enforce data retention limits.
 * (Prompt/completion columns were removed in #957 — no anonymization phase needed.)
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
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const purged = await purgeAiUsageLogs(ninetyDaysAgo);

    console.log(`[Cron] AI usage logs: purged ${purged}`);

    audit({ eventType: 'data.delete', userId: 'system', resourceType: 'cron_job', resourceId: 'purge_ai_usage', details: { purged } });

    return NextResponse.json({
      success: true,
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
