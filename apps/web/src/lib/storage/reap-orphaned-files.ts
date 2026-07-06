import { findOrphanedFileRecords, deleteFileRecords } from '@pagespace/lib/compliance/file-cleanup/orphan-detector';
import { createSystemFileDeleteToken } from '@pagespace/lib/services/validated-service-token';
import { updateStorageUsage, computeStorageCreditOnUnlink } from '@pagespace/lib/services/storage-limits';

type Database = typeof import('@pagespace/db/db').db;

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

export interface ReapResult {
  orphansFound: number;
  physicalFilesDeleted: number;
  dbRecordsDeleted: number;
  failedPhysicalDeletes: string[];
}

export interface ReapOptions {
  /**
   * Restrict the orphan scan to these file IDs. Pass the files a just-deleted
   * subtree referenced so a user-facing delete reaps only its own files instead
   * of sweeping the whole table inline. An empty array reaps nothing; omitting
   * it scans every file (the weekly cron's global sweep).
   */
  fileIds?: string[];
}

/**
 * Detect orphaned file records and reclaim them: delete the physical blob,
 * hard-delete the DB row, and credit the uploader's storage quota.
 *
 * Shared by the weekly cron (global sweep) AND the synchronous delete paths
 * (permanent delete from trash, 30-day purge) so a user who deletes files frees
 * their cap immediately instead of waiting up to a week for the next cron tick.
 * User-facing callers pass `fileIds` to bound the work to their own subtree.
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
export async function reapOrphanedFiles(database: Database, options?: ReapOptions): Promise<ReapResult> {
  const orphans = await findOrphanedFileRecords(
    database as Parameters<typeof findOrphanedFileRecords>[0],
    options?.fileIds,
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

  // A reaped orphan (physical blob already deleted above) whose row survived
  // deleteFileRecords's recheck means either (a) another concurrent reap
  // deleted the row first — benign, race-safe by design — or (b) the row
  // became newly referenced between the scan and the recheck, so its blob
  // is now gone out from under a live reference. deleteFileRecords doesn't
  // report which case occurred, but either way this is worth surfacing:
  // case (b) is the residual gap the #1867 lock-then-recheck fix narrows
  // but can't fully close (the physical delete already happened by this point).
  for (const orphan of reapedOrphans) {
    if (!deletedIdSet.has(orphan.id)) {
      console.warn(`[ReapOrphans] Physical blob for ${orphan.id} was deleted but its files row survived the recheck (raced with another reap or a new reference) — the row may now point at a missing blob.`);
    }
  }

  // Credit storage quota back for every reaped orphan whose row this call
  // actually deleted. computeStorageCreditOnUnlink (M8) centralizes the rules:
  // attribute to the original uploader (createdBy), skip rows nulled by a user
  // cascade, skip rows another reap already removed (race-safe), skip DB-only
  // stubs whose bytes were never persisted — and issue exactly ONE credit per
  // blob, symmetric with the single first-store charge.
  for (const orphan of reapedOrphans) {
    const credit = computeStorageCreditOnUnlink({
      createdBy: orphan.createdBy,
      sizeBytes: orphan.sizeBytes,
      deletedByThisCall: deletedIdSet.has(orphan.id),
      hadPhysicalBlob: true,
    });
    if (!credit) continue;
    try {
      await updateStorageUsage(credit.userId, credit.deltaBytes, {
        driveId: orphan.driveId ?? undefined,
        eventType: 'delete',
      });
    } catch (error) {
      console.warn(`[ReapOrphans] Failed to credit storage for ${credit.userId} (${credit.deltaBytes}):`, error);
    }
  }

  return {
    orphansFound: orphans.length,
    physicalFilesDeleted,
    dbRecordsDeleted: deletedIds.length,
    failedPhysicalDeletes,
  };
}
