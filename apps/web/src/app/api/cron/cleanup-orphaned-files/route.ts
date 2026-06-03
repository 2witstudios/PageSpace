import { db } from '@pagespace/db/db';
import { audit } from '@pagespace/lib/audit/audit-log';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { reapOrphanedFiles } from '@/lib/storage/reap-orphaned-files';

/**
 * Cron endpoint to detect and clean up orphaned files.
 *
 * The actual reaping (detect → delete physical blob → hard-delete DB row →
 * credit the uploader's storage quota) lives in the shared
 * `reapOrphanedFiles` helper, which the synchronous delete paths (permanent
 * delete, 30-day purge) also call so quota frees immediately rather than
 * waiting for this weekly tick. This cron is the safety net that catches
 * orphans created by paths that don't reap inline (e.g. user-account
 * deletion, soft-deleted DM messages).
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
    const result = await reapOrphanedFiles(db);

    console.log(
      `[Cron] Orphaned file cleanup: ${result.orphansFound} orphans found, ` +
      `${result.physicalFilesDeleted} physical files deleted, ${result.dbRecordsDeleted} DB records deleted`
    );

    audit({
      eventType: 'data.delete',
      resourceType: 'cron_job',
      resourceId: 'cleanup_orphaned_files',
      details: {
        orphansFound: result.orphansFound,
        filesDeleted: result.dbRecordsDeleted,
        physicalFilesDeleted: result.physicalFilesDeleted,
      },
    });

    return NextResponse.json({
      success: true,
      orphansFound: result.orphansFound,
      filesDeleted: result.dbRecordsDeleted,
      physicalFilesDeleted: result.physicalFilesDeleted,
      failedPhysicalDeletes: result.failedPhysicalDeletes.length > 0 ? result.failedPhysicalDeletes : undefined,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Error running orphaned file cleanup:', error);
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
