import {
  archiveActivityLogs,
  getActivityLogArchivalConfig,
} from '@pagespace/lib/compliance/retention/activity-log-archival';
import { quickIntegrityCheck } from '@pagespace/lib/monitoring/hash-chain-verifier';
import { db } from '@pagespace/db/db';
import { audit } from '@pagespace/lib/audit/audit-log';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to archive (hot→cold tier) old activity_logs rows.
 *
 * Flips `isArchived = true` on rows older than ACTIVITY_LOGS_ARCHIVE_DAYS
 * (default 365), batched and bounded by a per-run wall-clock budget. This is a
 * flag flip ONLY: it never deletes rows and never touches the tamper-evident
 * hash chain, so chain verification is unaffected.
 *
 * Defense in depth: runs the hash-chain quick integrity check before and after
 * the run and reports both in the response. `isArchived` is not a hash input,
 * so a difference here would indicate a bug, not normal operation.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature headers.
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const before = await quickIntegrityCheck();

    const config = getActivityLogArchivalConfig();
    const result = await archiveActivityLogs(
      db as Parameters<typeof archiveActivityLogs>[0],
      config,
    );

    const after = await quickIntegrityCheck();

    console.log(
      `[Cron] activity_logs archival: ${result.archived} rows flipped across ${result.batches} batch(es)`,
    );

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'archive_activity_logs',
      details: {
        archived: result.archived,
        batches: result.batches,
        archiveDays: config.archiveDays,
        chainIntegrityBefore: before.isLikelyValid,
        chainIntegrityAfter: after.isLikelyValid,
      },
    });

    return NextResponse.json({
      success: true,
      archived: result.archived,
      batches: result.batches,
      chainIntegrity: { before, after },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Error archiving activity logs:', error);
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
