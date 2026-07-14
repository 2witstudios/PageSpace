import { reconcileOrphanSprites } from '@pagespace/lib/services/machines/machine-orphan-reconcile';
import { audit } from '@pagespace/lib/audit/audit-log';
import { NextResponse } from 'next/server';
import { defaultReconcileOrphanSpritesDeps } from '@/lib/machines/machine-orphan-reconcile-runtime';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint that reclaims ORPHANED Sprites — microVMs whose Machine page was
 * deleted but whose teardown never confirmed, so they keep billing RAM with no
 * owner reachable from inside the app (Sprites Idle-Cost Remediation).
 *
 * `deleteMachine` tears Sprites down best-effort and documents a failed kill as
 * "a recoverable state a background reconciler can reclaim" — this is that
 * reconciler. Candidates are tracking rows (`machine_sessions` /
 * `machine_branches`) that still exist while their owning page is trashed; both
 * tables now drop their row only after a confirmed kill, so a surviving row IS
 * the pending-teardown signal. See `machine-orphan-reconcile.ts` in @pagespace/lib.
 *
 * Runs every 30 minutes — comfortably ahead of the daily 30-day hard purge, whose
 * FK cascade would otherwise destroy the only pointer (`sandboxId`) to an orphan.
 * That purge now refuses to delete a page with a live tracking row
 * (`purgeExpiredTrashedPages`), so the two crons cannot race a Sprite into the
 * unreachable state.
 *
 * No advisory lock (unlike reconcile-machine-storage, whose charge is a
 * non-idempotent money movement): the kill is idempotent and the row deletes are
 * naturally concurrency-safe, so overlapping runs converge. The crontab's flock
 * is enough.
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
    const run = await reconcileOrphanSprites(defaultReconcileOrphanSpritesDeps);

    console.log(
      `[Cron] Orphan sprite reconcile: processed ${run.processed}, torndown ${run.torndown}, skipped ${run.skipped}, failed ${run.failed}${run.capped ? ' (CAPPED — backlog remains, draining next tick)' : ''}`,
    );

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'reconcile_orphaned_sprites',
      details: {
        processed: run.processed,
        torndown: run.torndown,
        skipped: run.skipped,
        failed: run.failed,
        capped: run.capped,
      },
    });

    return NextResponse.json({
      success: true,
      processed: run.processed,
      torndown: run.torndown,
      skipped: run.skipped,
      failed: run.failed,
      capped: run.capped,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Error reconciling orphaned sprites:', error);
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
