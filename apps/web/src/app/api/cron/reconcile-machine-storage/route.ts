import {
  defaultReconcileMachineStorageDeps,
  reconcileMachineStorageSerialized,
} from '@pagespace/lib/services/sandbox/machine-storage-billing';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint that meters Terminal Machines' persistent-storage cost (Sprites
 * Platform Alignment 6-1). The platform bills for the bytes a machine has
 * ACTUALLY written (TRIM-friendly), not the provisioned allocation, so this
 * bills EVERY known machine — active or hibernating — from its last PERSISTED
 * MEASURED footprint (captured opportunistically while the sprite was awake for
 * real work), to the machine's actual page owner. It NEVER wakes a sprite to
 * measure; a never-measured machine bills a conservative 0 for that window.
 *
 * Idempotent / drift-correcting for SEQUENTIAL runs: each machine tracks its
 * own last-billed watermark, so a rerun bills zero elapsed time and a missed
 * run is caught up exactly on the next one — see `reconcileMachineStorage`
 * in @pagespace/lib. CONCURRENT invocations are made safe by
 * `reconcileMachineStorageSerialized`'s Postgres advisory try-lock: a run that
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
    const run = await reconcileMachineStorageSerialized(defaultReconcileMachineStorageDeps);

    if (run.outcome === 'lock_busy') {
      console.log('[Cron] Terminal storage reconcile: skipped — advisory lock held by another run');
      return NextResponse.json({
        success: true,
        outcome: 'lock_busy',
        timestamp: new Date().toISOString(),
      });
    }

    console.log(
      `[Cron] Terminal storage reconcile: processed ${run.processed}, charged ${run.charged}, skipped ${run.skipped}, failed ${run.failed}, stale ${run.staleMeasurements}, total $${run.totalCostDollars.toFixed(6)}`,
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
