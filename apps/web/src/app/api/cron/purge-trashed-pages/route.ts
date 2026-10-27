import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { reapOrphanedFiles } from '@/lib/storage/reap-orphaned-files';

/**
 * Cron endpoint to hard-delete pages that have been in the trash for 30+ days.
 *
 * Implements Art. 17 GDPR erasure: trashed pages are soft-deleted immediately,
 * then permanently removed after the 30-day retention window.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature headers.
 *
 * The Phase 8 teardown removed the denormalized MachineRef sweep this route
 * used to also run (issue #2156): `pages.machines`/`global_assistant_config.machines`
 * are dropped columns now, and every live Sprite pointer this purge's cascade
 * orphans is rescued into the FK-less reclaim outbox by the AFTER-DELETE
 * trigger (see `reconcile-orphaned-sprites`), so there is no dangling
 * reference left for a sweep to reconcile.
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const pagesPurged = await pageRepository.purgeExpiredTrashedPages(thirtyDaysAgo);

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
      details: { pagesPurged, filesReaped },
    });

    return NextResponse.json({
      success: true,
      pagesPurged,
      filesReaped,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    loggers.system.error('[Cron] Error purging trashed pages', error as Error);
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
