import { db, systemLogs, apiMetrics, errorLogs, lt } from '@pagespace/db';
import { audit } from '@pagespace/lib/server';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to purge old operational logs.
 *
 * Deletes rows older than LOG_RETENTION_DAYS (default 30) from:
 *   - system_logs
 *   - api_metrics
 *   - error_logs
 *
 * The compliance-critical security audit log table is intentionally NOT
 * purged here — its tamper-evident hash chain must remain intact for
 * regulatory retention. Do not add it to the list of purged tables.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce,
 * X-Cron-Signature headers.
 */
const DEFAULT_RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function resolveRetentionDays(): number {
  const raw = process.env.LOG_RETENTION_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const retentionDays = resolveRetentionDays();
    const now = new Date();
    const cutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY);

    const [sysDeleted, apiDeleted, errDeleted] = await Promise.all([
      db
        .delete(systemLogs)
        .where(lt(systemLogs.timestamp, cutoff))
        .returning({ id: systemLogs.id }),
      db
        .delete(apiMetrics)
        .where(lt(apiMetrics.timestamp, cutoff))
        .returning({ id: apiMetrics.id }),
      db
        .delete(errorLogs)
        .where(lt(errorLogs.timestamp, cutoff))
        .returning({ id: errorLogs.id }),
    ]);

    const purged = {
      system_logs: sysDeleted.length,
      api_metrics: apiDeleted.length,
      error_logs: errDeleted.length,
    };

    console.log(
      `[Cron] Operational logs purged (retention ${retentionDays}d):`,
      purged
    );

    audit({
      eventType: 'data.delete',
      userId: 'system',
      resourceType: 'cron_job',
      resourceId: 'purge_operational_logs',
      details: { retentionDays, ...purged },
    });

    return NextResponse.json({
      success: true,
      purged,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Error purging operational logs:', error);
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
