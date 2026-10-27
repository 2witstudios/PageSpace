import { purgeAiUsageLogs } from '@pagespace/lib/logging/ai-usage-purge';
import { getAiUsageLogsRetentionDays, getRetentionCutoff } from '@pagespace/lib/compliance/retention/monitoring-retention';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to purge old AI usage logs.
 *
 * Deletes entire rows older than RETENTION_AI_USAGE_LOGS_DAYS (default 90) to
 * enforce data retention limits. The window is env-configurable so tenant
 * deployments can tune it without a code change.
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
    const cutoff = getRetentionCutoff(getAiUsageLogsRetentionDays());

    const purged = await purgeAiUsageLogs(cutoff);

    console.log(`[Cron] AI usage logs: purged ${purged}`);

    audit({ eventType: 'data.delete', resourceType: 'cron_job', resourceId: 'purge_ai_usage', details: { purged } });

    return NextResponse.json({
      success: true,
      purged,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    loggers.system.error('[Cron] Error purging AI usage logs', error as Error);
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
