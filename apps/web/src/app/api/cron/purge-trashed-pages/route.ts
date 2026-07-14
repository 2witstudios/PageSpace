import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { audit } from '@pagespace/lib/audit/audit-log';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { reapOrphanedFiles } from '@/lib/storage/reap-orphaned-files';

/**
 * Cron endpoint to hard-delete pages that have been in the trash for 30+ days.
 *
 * Implements Art. 17 GDPR erasure: trashed pages are soft-deleted immediately,
 * then permanently removed after the 30-day retention window.
 *
 * The purge SKIPS a page that still has a live Sprite-tracking row
 * (`machine_sessions` / `machine_branches`, both FK-cascading off `pages.id`):
 * deleting the page would take the row with it and destroy the only pointer
 * (`sandboxId`) to a microVM that may still be running and billing. Those rows
 * are cleared by the orphan reconcile cron (every 30 minutes), so a held-back
 * page is normally purged on the very next nightly run. `staleBlocked` counts
 * the ones still blocked 15 days PAST the purge cutoff (~45 days trashed) — far
 * beyond the reconciler's reach, so a non-zero value means a Sprite that cannot
 * be killed, and it stays visible instead of being silently destroyed.
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
    // Purge cutoff + a generous 15-day grace: a page still blocked at ~45 days
    // trashed has survived ~720 orphan-reconcile ticks, so it is not a transient
    // retry — it is a Sprite that cannot be killed.
    const staleBlockedCutoff = new Date(thirtyDaysAgo.getTime() - 15 * 24 * 60 * 60 * 1000);

    const pagesPurged = await pageRepository.purgeExpiredTrashedPages(thirtyDaysAgo);
    const staleBlocked = await pageRepository.countStaleBlockedTrashedPages(staleBlockedCutoff);

    if (staleBlocked > 0) {
      console.warn(
        `[Cron] ${staleBlocked} trashed page(s) held back from purge by a live Sprite-tracking row for 45+ days — an orphaned Sprite is likely still billing and cannot be killed. See reconcile-orphaned-sprites.`,
      );
    }

    // Purging the page rows orphans the files they backed. Reap inline so the
    // 30-day purge frees the uploader's storage cap immediately instead of
    // deferring to the weekly orphan cron. Best-effort: a reap failure must not
    // fail the purge — the weekly cron backstops it.
    let filesReaped = 0;
    try {
      const reaped = await reapOrphanedFiles(db);
      filesReaped = reaped.dbRecordsDeleted;
    } catch (error) {
      console.warn('[Cron] Inline orphan reap after purge failed; weekly cron will retry:', error);
    }

    console.log(`[Cron] Purged trashed pages: ${pagesPurged}, reaped orphaned files: ${filesReaped}`);

    audit({
      eventType: 'data.delete',
      resourceType: 'cron_job',
      resourceId: 'purge_trashed_pages',
      details: { pagesPurged, filesReaped, staleBlocked },
    });

    return NextResponse.json({
      success: true,
      pagesPurged,
      filesReaped,
      staleBlocked,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Error purging trashed pages:', error);
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
