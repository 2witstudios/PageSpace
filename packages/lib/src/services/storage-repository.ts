/**
 * Storage Repository - Database access layer for storage operations.
 * Provides a clean seam for testing storage-limits without ORM chain mocks.
 */

import { db } from '@pagespace/db/db';
import { eq, sql, and, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { pages, drives, storageEvents } from '@pagespace/db/schema/core';
import { files } from '@pagespace/db/schema/storage';

export type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface StorageUserRecord {
  id: string;
  storageUsedBytes: number;
  subscriptionTier: string | null;
}

export interface StorageDriftCandidate {
  userId: string;
  /** users.storageUsedBytes — the cached counter. */
  materializedBytes: number;
  /** SUM(files.sizeBytes) for files.createdBy = userId — the source of truth. */
  derivedBytes: number;
}

export const storageRepository = {
  findUserForStorage: async (userId: string): Promise<StorageUserRecord | undefined> => {
    return db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, storageUsedBytes: true, subscriptionTier: true },
    }) as Promise<StorageUserRecord | undefined>;
  },

  /**
   * #2155 — set-based drift scan for the scheduled reconcile: every user whose
   * storageUsedBytes cache differs from SUM(files.sizeBytes) over their files
   * rows by more than the tolerance. One aggregate over `files` (grouped by
   * creator) joined to `users`, so the cron pays a single pass regardless of
   * user count.
   */
  findStorageDriftCandidates: async (toleranceBytes: number): Promise<StorageDriftCandidate[]> => {
    const result = await db.execute(sql`
      SELECT u.id AS "userId",
             u."storageUsedBytes" AS "materializedBytes",
             COALESCE(f.total, 0) AS "derivedBytes"
      FROM users u
      LEFT JOIN (
        SELECT "createdBy", SUM("sizeBytes") AS total
        FROM files
        WHERE "createdBy" IS NOT NULL
        GROUP BY "createdBy"
      ) f ON f."createdBy" = u.id
      WHERE ABS(ROUND(u."storageUsedBytes") - COALESCE(f.total, 0)) > ${Math.max(0, Math.round(toleranceBytes))}
    `);
    return result.rows.map((row) => {
      const r = row as { userId: string; materializedBytes: number | string; derivedBytes: number | string };
      return {
        userId: r.userId,
        materializedBytes: Number(r.materializedBytes),
        derivedBytes: Number(r.derivedBytes),
      };
    });
  },

  findUserDriveIds: async (userId: string): Promise<string[]> => {
    const userDrives = await db.query.drives.findMany({
      where: eq(drives.ownerId, userId),
      columns: { id: true },
    });
    return userDrives.map((d: { id: string }) => d.id);
  },

  /**
   * H4: the reconcile population — every `files` row the user uploaded
   * (createdBy = userId), across all drives, including trashed-but-unpurged
   * files (the `files` row outlives a trashed page until the reaper deletes it).
   * Returns raw byte values; the pure `sumStorageBytes` does the integer-safe sum.
   */
  findFilesByCreator: async (userId: string): Promise<Array<{ sizeBytes: number }>> => {
    const rows = await db
      .select({ sizeBytes: files.sizeBytes })
      .from(files)
      .where(eq(files.createdBy, userId));
    return rows.map((r: { sizeBytes: number | string | null }) => ({
      sizeBytes: typeof r.sizeBytes === 'string' ? Number(r.sizeBytes) : (r.sizeBytes ?? 0),
    }));
  },

  /**
   * H3: does the caller already legitimately reference this content hash?
   * True when the caller uploaded the blob before (files.createdBy = userId, in
   * any drive) OR a FILE page in the target drive already points at the hash.
   * Only such callers may take the dedup fast-path / link a pre-existing object.
   */
  userReferencesContentHash: async (
    userId: string,
    contentHash: string,
    driveId: string,
  ): Promise<boolean> => {
    const result = await db.execute(sql`
      SELECT 1 WHERE EXISTS (
        SELECT 1 FROM files WHERE id = ${contentHash} AND "createdBy" = ${userId}
      ) OR EXISTS (
        SELECT 1 FROM pages
        WHERE "contentHash" = ${contentHash} AND "driveId" = ${driveId} AND type = 'FILE'
      )
    `);
    return result.rows.length > 0;
  },

  countFiles: async (driveIds: string[]): Promise<number> => {
    const result = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(pages)
      .where(and(
        inArray(pages.driveId, driveIds),
        eq(pages.type, 'FILE'),
        eq(pages.isTrashed, false),
      ));
    return Number(result[0]?.count ?? 0);
  },

  updateStorageInTx: async (
    tx: DrizzleTx,
    userId: string,
    deltaBytes: number,
  ): Promise<{ newUsage: number }> => {
    const [updatedUser] = await tx
      .update(users)
      .set({
        storageUsedBytes: sql`GREATEST(0, COALESCE("storageUsedBytes", 0) + ${deltaBytes})`,
        lastStorageCalculated: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({ newUsage: users.storageUsedBytes });
    return { newUsage: updatedUser.newUsage ?? 0 };
  },

  insertStorageEvent: async (
    tx: DrizzleTx,
    event: typeof storageEvents.$inferInsert,
  ): Promise<void> => {
    await tx.insert(storageEvents).values(event);
  },

  setUserStorageInTx: async (
    tx: DrizzleTx,
    userId: string,
    absoluteBytes: number,
  ): Promise<void> => {
    await tx.update(users)
      .set({ storageUsedBytes: absoluteBytes, lastStorageCalculated: new Date() })
      .where(eq(users.id, userId));
  },

  runTransaction: <T>(fn: (tx: DrizzleTx) => Promise<T>): Promise<T> => {
    return db.transaction(fn);
  },
};
