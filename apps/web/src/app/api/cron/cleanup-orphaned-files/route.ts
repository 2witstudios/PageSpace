import { findOrphanedFileRecords, deleteFileRecords } from '@pagespace/lib/compliance/file-cleanup/orphan-detector';
import { db } from '@pagespace/db';
import { createDriveServiceToken } from '@pagespace/lib';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import type { ServiceScope } from '@pagespace/lib';

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';
const FILE_DELETE_SCOPES: ServiceScope[] = ['files:delete'];

/**
 * Cron endpoint to detect and clean up orphaned files.
 *
 * An orphaned file is one with zero references across filePages, channelMessages,
 * and pages tables. For each orphan:
 * 1. Calls processor service to delete physical file + cache
 * 2. Deletes the DB record
 *
 * Authentication:
 * - Primary: CRON_SECRET Bearer token (timing-safe comparison)
 * - Defense-in-depth: internal network origin check
 *
 * Trigger via:
 * curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/cleanup-orphaned-files
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const orphans = await findOrphanedFileRecords(db as Parameters<typeof findOrphanedFileRecords>[0]);

    if (orphans.length === 0) {
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

    // Delete physical files via processor service
    for (const orphan of orphans) {
      if (!orphan.storagePath) continue;

      // Extract content hash from storagePath (format: /storage/<contentHash>/original or just the hash)
      const contentHash = orphan.storagePath.split('/').filter(Boolean).find(segment =>
        /^[a-f0-9]{64}$/i.test(segment)
      );

      if (!contentHash) {
        console.warn(`[Cron] Orphan ${orphan.id} has malformed storagePath (no valid content hash): ${orphan.storagePath}`);
        failedPhysicalDeletes.push(orphan.id);
        continue;
      }

      try {
        const { token } = await createDriveServiceToken(
          'system',
          orphan.driveId,
          FILE_DELETE_SCOPES,
          '30s',
        );

        const response = await fetch(`${PROCESSOR_URL}/api/files/${contentHash}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) {
          physicalFilesDeleted++;
        } else {
          failedPhysicalDeletes.push(orphan.id);
          console.warn(`[Cron] Failed to delete physical file for ${orphan.id}: ${response.status}`);
        }
      } catch (error) {
        failedPhysicalDeletes.push(orphan.id);
        console.warn(`[Cron] Error deleting physical file for ${orphan.id}:`, error);
      }
    }

    // Delete DB records (even if physical delete failed - the file is orphaned regardless)
    const dbDeleted = await deleteFileRecords(
      db as Parameters<typeof deleteFileRecords>[0],
      orphans.map(o => o.id),
    );

    console.log(
      `[Cron] Orphaned file cleanup: ${orphans.length} orphans found, ` +
      `${physicalFilesDeleted} physical files deleted, ${dbDeleted} DB records deleted`
    );

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
