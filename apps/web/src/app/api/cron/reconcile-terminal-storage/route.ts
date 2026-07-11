import { reconcileTerminalStorage } from '@pagespace/lib/services/sandbox/terminal-storage-reconcile';
import { defaultReconcileTerminalStorageDeps } from '@pagespace/lib/services/sandbox/terminal-storage-billing';
import { audit } from '@pagespace/lib/audit/audit-log';
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
 * Idempotent / drift-correcting: each machine tracks its own last-billed
 * watermark, so overlapping or repeated runs never double-bill and a missed
 * run is caught up exactly on the next one — see
 * `reconcileTerminalStorage` in @pagespace/lib.
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
    const result = await reconcileTerminalStorage(defaultReconcileTerminalStorageDeps);

    console.log(
      `[Cron] Terminal storage reconcile: processed ${result.processed}, charged ${result.charged}, skipped ${result.skipped}, failed ${result.failed}, stale ${result.staleMeasurements}, total $${result.totalCostDollars.toFixed(6)}`,
    );

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'reconcile_terminal_storage',
      details: {
        processed: result.processed,
        charged: result.charged,
        skipped: result.skipped,
        failed: result.failed,
        staleMeasurements: result.staleMeasurements,
        totalCostDollars: result.totalCostDollars,
      },
    });

    return NextResponse.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Error reconciling terminal storage:', error);
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
