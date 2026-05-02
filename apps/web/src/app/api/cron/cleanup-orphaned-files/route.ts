import { findOrphanedFileRecords, deleteFileRecords } from '@pagespace/lib/compliance/file-cleanup/orphan-detector';
import { db } from '@pagespace/db/db';
import {
  createDriveServiceToken,
  createSystemFileDeleteToken,
} from '@pagespace/lib/services/validated-service-token';
import { updateStorageUsage } from '@pagespace/lib/services/storage-limits';
import { audit } from '@pagespace/lib/audit/audit-log';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import type { ServiceScope } from '@pagespace/lib/services/validated-service-token';

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';
const FILE_DELETE_SCOPES: ServiceScope[] = ['files:delete'];

/**
 * Cron endpoint to detect and clean up orphaned files.
 *
 * For each orphan returned by the detector:
 *   1. Mint a delete token — drive-scoped if the file has a driveId, otherwise
 *      a system file-bound token (covers DM-only attachments and any other
 *      conversation-only blob with no live drive association).
 *   2. Call the processor to delete the physical blob + cache.
 *   3. On success, hard-delete the DB row and credit the uploader's storage
 *      quota by exactly -sizeBytes. On failure, leave the row so the orphan
 *      retries on the next scheduled run and the quota stays unchanged.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature headers.
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const orphans = await findOrphanedFileRecords(db as Parameters<typeof findOrphanedFileRecords>[0]);

    if (orphans.length === 0) {
      audit({ eventType: 'data.delete', resourceType: 'cron_job', resourceId: 'cleanup_orphaned_files', details: { orphansFound: 0, filesDeleted: 0, physicalFilesDeleted: 0 } });
      return NextResponse.json({
        success: true,
        orphansFound: 0,
        filesDeleted: 0,
        physicalFilesDeleted: 0,
        timestamp: new Date().toISOString(),
      });
    }

    let physicalFilesDeleted = 0;
    const failedPhysicalDeletes: string[] = [];
    const reapedOrphans: typeof orphans = [];

    for (const orphan of orphans) {
      if (!orphan.storagePath) continue;

      const contentHash = orphan.storagePath.split('/').filter(Boolean).find(segment =>
        /^[a-f0-9]{64}$/i.test(segment)
      );

      if (!contentHash) {
        console.warn(`[Cron] Orphan ${orphan.id} has malformed storagePath (no valid content hash): ${orphan.storagePath}`);
        failedPhysicalDeletes.push(orphan.id);
        continue;
      }

      try {
        const { token } = orphan.driveId
          ? await createDriveServiceToken('system', orphan.driveId, FILE_DELETE_SCOPES, '30s')
          : await createSystemFileDeleteToken({ contentHash, expiresIn: '30s' });

        const response = await fetch(`${PROCESSOR_URL}/api/files/${contentHash}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) {
          physicalFilesDeleted++;
          reapedOrphans.push(orphan);
        } else {
          failedPhysicalDeletes.push(orphan.id);
          console.warn(`[Cron] Failed to delete physical file for ${orphan.id}: ${response.status}`);
        }
      } catch (error) {
        failedPhysicalDeletes.push(orphan.id);
        console.warn(`[Cron] Error deleting physical file for ${orphan.id}:`, error);
      }
    }

    const safeToDelete = reapedOrphans.map(o => o.id);

    const dbDeleted = safeToDelete.length > 0
      ? await deleteFileRecords(
          db as Parameters<typeof deleteFileRecords>[0],
          safeToDelete,
        )
      : 0;

    // Credit storage quota back for every successfully-reaped orphan. We attribute
    // to the original uploader (createdBy). Orphans whose createdBy was nulled
    // (cascade from user delete) skip the credit — there's no quota to refund.
    for (const orphan of reapedOrphans) {
      if (!orphan.createdBy) continue;
      try {
        await updateStorageUsage(orphan.createdBy, -orphan.sizeBytes, {
          driveId: orphan.driveId ?? undefined,
          eventType: 'delete',
        });
      } catch (error) {
        console.warn(`[Cron] Failed to credit storage for ${orphan.createdBy} (-${orphan.sizeBytes}):`, error);
      }
    }

    console.log(
      `[Cron] Orphaned file cleanup: ${orphans.length} orphans found, ` +
      `${physicalFilesDeleted} physical files deleted, ${dbDeleted} DB records deleted`
    );

    audit({ eventType: 'data.delete', resourceType: 'cron_job', resourceId: 'cleanup_orphaned_files', details: { orphansFound: orphans.length, filesDeleted: dbDeleted, physicalFilesDeleted } });

    return NextResponse.json({
      success: true,
      orphansFound: orphans.length,
      filesDeleted: dbDeleted,
      physicalFilesDeleted,
      failedPhysicalDeletes: failedPhysicalDeletes.length > 0 ? failedPhysicalDeletes : undefined,
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
