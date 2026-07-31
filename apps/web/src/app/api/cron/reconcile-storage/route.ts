import { reconcileAllStorageUsageSerialized } from '@pagespace/lib/services/storage-limits';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint that reconciles the `users.storageUsedBytes` cache against the
 * source of truth — SUM(files.sizeBytes) over files.createdBy (#2155).
 *
 * The cache is updated at upload-complete and credited by the orphan reaper,
 * but nothing previously re-derived it on a schedule; `?reconcile=true` on
 * api/storage/info was the only repair path, and it was opt-in/admin-gated.
 * This makes the repair unconditional and scheduled — every user whose cache
 * has drifted beyond tolerance gets rewritten from the `files` rows, with a
 * `reconcile` storage event recorded per correction for audit.
 *
 * A non-empty `failed` list means a per-user transaction failed (isolated so
 * one bad account can't block the sweep) — logged loudly so it surfaces as an
 * alert rather than a silent skip.
 *
 * Serialized across EVERY caller (any container, any manual/API trigger) via
 * a Postgres advisory try-lock — two overlapping runs reading the same drift
 * candidate would each independently apply the same correction delta,
 * double-counting it. A run that finds the lock held no-ops cleanly; the
 * next scheduled tick (or the tick that's already running) covers the drift.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce,
 * X-Cron-Signature headers.
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const run = await reconcileAllStorageUsageSerialized();

    if (run.outcome === 'lock_busy') {
      console.log('[Cron] Storage reconcile: skipped — advisory lock held by another run');
      return NextResponse.json({
        success: true,
        outcome: 'lock_busy',
        timestamp: new Date().toISOString(),
      });
    }

    const result = run;

    console.log(
      `[Cron] Storage reconcile: corrected ${result.corrected.length}, failed ${result.failed.length}`,
    );

    if (result.failed.length > 0) {
      loggers.system.error('[Cron] Storage reconcile: per-user corrections failed', undefined, {
        failed: result.failed,
      });
    }

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'reconcile_storage',
      details: {
        corrected: result.corrected.length,
        failed: result.failed.length,
        corrections: result.corrected,
        failedUserIds: result.failed,
      },
    });

    return NextResponse.json({
      success: result.failed.length === 0,
      corrected: result.corrected.length,
      failed: result.failed.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    loggers.system.error('[Cron] Error reconciling storage', error as Error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
