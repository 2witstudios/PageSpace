import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { reapOrphanedFiles } from '@/lib/storage/reap-orphaned-files';
import { sweepDanglingMachineRefs } from '@/lib/machines/machine-ref-sweep-runtime';

/**
 * Cron endpoint to hard-delete pages that have been in the trash for 30+ days.
 *
 * Implements Art. 17 GDPR erasure: trashed pages are soft-deleted immediately,
 * then permanently removed after the 30-day retention window.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature headers.
 *
 * This is also where denormalized MachineRefs are reconciled (issue #2156). The
 * purge is the moment a Machine page stops existing, and its refs — copied into
 * `pages.machines` on agent pages and `global_assistant_config.machines` — have
 * no FK to cascade them away. The sweep runs UNSCOPED here on purpose: it is the
 * backstop for every path that can destroy a Machine page without telling
 * anyone (account erasure, permanent drive delete, manual DB surgery), not just
 * for the rows this run purged.
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

    // Drop MachineRefs left pointing at machines that no longer exist. Same
    // best-effort contract as the reap above: a sweep failure must not fail the
    // purge — the next daily run retries it, and a dangling ref degrades only to
    // today's behavior.
    let machineRefsScrubbed = 0;
    try {
      const swept = await sweepDanglingMachineRefs();
      machineRefsScrubbed = swept.agentsUpdated + swept.globalConfigsUpdated;
      if (swept.failures > 0) {
        loggers.system.warn('[Cron] Some machine-ref rewrites failed; next run will retry', {
          failures: swept.failures,
          deadMachineIds: swept.deadMachineIds,
        });
      }
    } catch (error) {
      loggers.system.warn('[Cron] Dangling machine-ref sweep failed; next run will retry', {
        error: error as Error,
      });
    }

    console.log(
      `[Cron] Purged trashed pages: ${pagesPurged}, reaped orphaned files: ${filesReaped}, scrubbed machine refs: ${machineRefsScrubbed}`,
    );

    audit({
      eventType: 'data.delete',
      resourceType: 'cron_job',
      resourceId: 'purge_trashed_pages',
      details: { pagesPurged, filesReaped, machineRefsScrubbed },
    });

    return NextResponse.json({
      success: true,
      pagesPurged,
      filesReaped,
      machineRefsScrubbed,
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
