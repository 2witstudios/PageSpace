import { findOrphanedFileRecords, deleteFileRecords } from '@pagespace/lib/compliance/file-cleanup/orphan-detector';
import { createSystemFileDeleteToken } from '@pagespace/lib/services/validated-service-token';
import { updateStorageUsage } from '@pagespace/lib/services/storage-limits';

type Database = typeof import('@pagespace/db/db').db;

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

export interface ReapResult {
  orphansFound: number;
  physicalFilesDeleted: number;
  dbRecordsDeleted: number;
  failedPhysicalDeletes: string[];
}

/**
 * Detect orphaned file records and reclaim them: delete the physical blob,
 * hard-delete the DB row, and credit the uploader's storage quota.
 *
 * Shared by the weekly cron AND the synchronous delete paths (permanent
 * delete from trash, 30-day purge) so a user who deletes files frees their
 * cap immediately instead of waiting up to a week for the next cron tick.
 *
 * For each orphan:
 *   1. null storagePath (DB stub, no blob ever persisted) → hard-delete the
 *      row only, no storage credit (the bytes were never on disk).
 *   2. otherwise mint a system file-bound delete token and ask the processor
 *      to delete the blob + cache. The processor re-verifies orphan status,
 *      so a re-link between scan and delete is safe.
 *   3. On a successful physical delete, hard-delete the row and credit the
 *      original uploader by exactly -sizeBytes. Crediting is gated on the row
 *      actually being deleted by THIS call (deleteFileRecords returns the IDs
 *      it removed), so two concurrent reaps can't double-credit the same blob.
 *      On failure the row is left for the next run and the quota is unchanged.
 */
export async function reapOrphanedFiles(database: Database): Promise<ReapResult> {
  const orphans = await findOrphanedFileRecords(
    database as Parameters<typeof findOrphanedFileRecords>[0],
  );

  if (orphans.length === 0) {
    return { orphansFound: 0, physicalFilesDeleted: 0, dbRecordsDeleted: 0, failedPhysicalDeletes: [] };
  }

  let physicalFilesDeleted = 0;
  const failedPhysicalDeletes: string[] = [];
  const reapedOrphans: typeof orphans = [];
  const dbOnlyOrphans: typeof orphans = [];

  for (const orphan of orphans) {
    // No physical blob to delete — just hard-delete the DB row. Skip the
    // storage credit because the row claims sizeBytes but the bytes were
    // never persisted (e.g. an aborted upload left a stub).
    if (!orphan.storagePath) {
      dbOnlyOrphans.push(orphan);
      continue;
    }

    const contentHash = orphan.storagePath.split('/').filter(Boolean).find(segment =>
      /^[a-f0-9]{64}$/i.test(segment),
    );

    if (!contentHash) {
      console.warn(`[ReapOrphans] Orphan ${orphan.id} has malformed storagePath (no valid content hash): ${orphan.storagePath}`);
      failedPhysicalDeletes.push(orphan.id);
      continue;
    }

    try {
      const { token } = await createSystemFileDeleteToken({ contentHash, expiresIn: '30s' });

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
        console.warn(`[ReapOrphans] Failed to delete physical file for ${orphan.id}: ${response.status}`);
      }
    } catch (error) {
      failedPhysicalDeletes.push(orphan.id);
      console.warn(`[ReapOrphans] Error deleting physical file for ${orphan.id}:`, error);
    }
  }

  const safeToDelete = [...reapedOrphans, ...dbOnlyOrphans].map(o => o.id);

  const deletedIds = safeToDelete.length > 0
    ? await deleteFileRecords(
        database as Parameters<typeof deleteFileRecords>[0],
        safeToDelete,
      )
    : [];
  const deletedIdSet = new Set(deletedIds);

  // Credit storage quota back for every reaped orphan whose row this call
  // actually deleted. Attribute to the original uploader (createdBy); orphans
  // whose createdBy was nulled (cascade from user delete) skip the credit, as
  // do DB-only orphans whose bytes were never persisted.
  for (const orphan of reapedOrphans) {
    if (!orphan.createdBy) continue;
    if (!deletedIdSet.has(orphan.id)) continue;
    try {
      await updateStorageUsage(orphan.createdBy, -orphan.sizeBytes, {
        driveId: orphan.driveId ?? undefined,
        eventType: 'delete',
      });
    } catch (error) {
      console.warn(`[ReapOrphans] Failed to credit storage for ${orphan.createdBy} (-${orphan.sizeBytes}):`, error);
    }
  }

  return {
    orphansFound: orphans.length,
    physicalFilesDeleted,
    dbRecordsDeleted: deletedIds.length,
    failedPhysicalDeletes,
  };
}
