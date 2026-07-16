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
 * Two sources (see `machine-orphan-reconcile.ts` in @pagespace/lib):
 *
 *   (A) the RECLAIM OUTBOX — `sandboxId`s rescued by AFTER DELETE triggers as
 *       their tracking row was cascaded away by a page/drive/user hard delete:
 *       the 30-day purge, "delete permanently" from the trash, GDPR account
 *       erasure. Those Sprites have no pointer left anywhere else, so they bill
 *       forever unless this cron kills them. The trigger runs inside the deleting
 *       transaction, so no delete path can strand a VM — and none of them needs a
 *       guard, which matters because Art. 17 erasure must never be blocked by a
 *       Sprite we failed to kill.
 *
 *   (B) tracking rows under a TRASHED page whose teardown was REQUESTED but never
 *       confirmed — a `deleteMachine` whose kill failed (the "recoverable state a
 *       background reconciler can reclaim" its doc always promised). A Machine
 *       merely dragged to the trash is deliberately left alone: its Sprite
 *       hibernates and a restore is expected to hand back the disk — a kill is
 *       irreversible, a trash is not.
 *
 * A page restored mid-run is re-checked and skipped, and every release write is a
 * CAS, so a live Sprite is never recorded as dead.
 *
 * No advisory lock (unlike reconcile-machine-storage, whose charge is a
 * non-idempotent money movement): the kill is idempotent and every row write is
 * concurrency-safe, so overlapping runs converge. The crontab's flock is enough.
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
