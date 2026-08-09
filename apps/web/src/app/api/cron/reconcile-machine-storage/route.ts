import {
  defaultReconcileSandboxStorageDeps,
  reconcileSandboxStorageSerialized,
} from '@pagespace/lib/services/sandbox/sandbox-storage-billing';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint that meters agent sessions' persistent-storage cost (Sprites
 * Platform Alignment 6-1). The platform bills for the bytes a session's
 * sandbox has ACTUALLY written (TRIM-friendly), not the provisioned
 * allocation, so this bills EVERY known session sandbox — active or
 * hibernating — from its last PERSISTED MEASURED footprint, to the session's
 * agent page (or its owner, for a global-assistant session). It NEVER wakes a
 * sprite to measure; a never-measured session bills a conservative 0 for that
 * window.
 *
 * Path kept as `reconcile-machine-storage` (Phase 8 teardown renamed the
 * body, not the cron path or its advisory-lock key — both are external
 * contracts: the scheduler config references this URL, and the lock name
 * must stay identical across a rolling deploy).
 *
 * Idempotent / drift-correcting for SEQUENTIAL runs: each session tracks its
 * own last-billed watermark, so a rerun bills zero elapsed time and a missed
 * run is caught up exactly on the next one — see `reconcileSandboxStorage`
 * in @pagespace/lib. CONCURRENT invocations are made safe by
 * `reconcileSandboxStorageSerialized`'s Postgres advisory try-lock: a run that
 * cannot acquire it (another container, or a manual/API trigger, already
 * holds it) no-ops cleanly instead of racing the charge + watermark-advance
 * writes. The docker/cron crontab flock (defense in depth) still serializes
 * this ONE container's own scheduled ticks; the advisory lock is what makes
 * every OTHER caller overlap-safe too.
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
    const run = await reconcileSandboxStorageSerialized(defaultReconcileSandboxStorageDeps);

    if (run.outcome === 'lock_busy') {
      console.log('[Cron] Terminal storage reconcile: skipped — advisory lock held by another run');
      return NextResponse.json({
        success: true,
        outcome: 'lock_busy',
        timestamp: new Date().toISOString(),
      });
    }

    console.log(
      `[Cron] Terminal storage reconcile: processed ${run.processed}, charged ${run.charged}, skipped ${run.skipped}, failed ${run.failed}, chargedButUnadvanced ${run.chargedButUnadvanced}, stale ${run.staleMeasurements}, total $${run.totalCostDollars.toFixed(6)}`,
    );

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'reconcile_machine_storage',
      details: {
        processed: run.processed,
        charged: run.charged,
        skipped: run.skipped,
        failed: run.failed,
        chargedButUnadvanced: run.chargedButUnadvanced,
        staleMeasurements: run.staleMeasurements,
        totalCostDollars: run.totalCostDollars,
      },
    });

    return NextResponse.json({
      success: true,
      processed: run.processed,
      charged: run.charged,
      skipped: run.skipped,
      failed: run.failed,
      chargedButUnadvanced: run.chargedButUnadvanced,
      staleMeasurements: run.staleMeasurements,
      totalCostDollars: run.totalCostDollars,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    loggers.system.error('[Cron] Error reconciling terminal storage', error as Error);
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
