/**
 * Storage Repository - Database access layer for storage operations.
 * Provides a clean seam for testing storage-limits without ORM chain mocks.
 */

import { db } from '@pagespace/db/db';
import { eq, sql, and, inArray, desc, isNull, or } from '@pagespace/db/operators';
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
  /** SUM(files.sizeBytes) for files.createdBy = userId outside org drives — the source of truth. */
  derivedBytes: number;
}

/** Rows of one drive's stored bytes, by uploader — the re-attribution population (O-9). */
export interface DriveFileBytes {
  createdBy: string | null;
  sizeBytes: number;
}

/**
 * WAL-9, O-9: a personal quota counts only files OUTSIDE org drives. Bytes in an org drive bill
 * the org, whose usage is derived from its drives' files rows. A drive-less file (a DM
 * attachment) is personal. Used as a filter on a `files` LEFT JOIN `drives`.
 */
const personallyAttributed = or(isNull(files.driveId), isNull(drives.orgId));

const STORAGE_EVENT_CHUNK = 500;

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
   *
   * #2225 review — excludes users with a `files` row created within the last
   * `cooldownSeconds`: upload/complete inserts the `files` row and calls
   * `updateStorageUsage` as two SEPARATE steps (deliberately non-atomic — a
   * failure in the second must not roll back the successful page creation),
   * so there's a real window where `derivedBytes` already reflects a new
   * upload but `materializedBytes` doesn't yet. Scanning during that window
   * looks like drift; correcting it via delta lands the counter on the
   * CORRECT value in the instant, but then the upload's own pending
   * `updateStorageUsage` call still lands afterward and double-applies the
   * same bytes. The cooldown gives that pending call time to land before this
   * user is ever treated as a candidate, closing the window without touching
   * the upload route's intentionally-non-atomic bookkeeping split. (The
   * analogous window exists on the orphan-reaper's credit path too, but that
   * path deletes the `files` row so there's no timestamp left to key a
   * cooldown on — accepted as a narrower, self-healing residual risk. #2225
   * review round 6 — Codex flagged that this reconcile's cron schedule and
   * the orphan reaper's were both aligned to fire in the SAME instant weekly
   * (Sunday 06:00), turning that narrow race into a guaranteed weekly
   * contention window; docker/cron/crontab now offsets this reconcile 5
   * minutes off the hour specifically to break that alignment. The
   * underlying race is still accepted as self-healing — this only removes
   * the schedule-driven guarantee that it fires.)
   */
  findStorageDriftCandidates: async (toleranceBytes: number, cooldownSeconds: number): Promise<StorageDriftCandidate[]> => {
    const result = await db.execute(sql`
      SELECT u.id AS "userId",
             u."storageUsedBytes" AS "materializedBytes",
             COALESCE(f.total, 0) AS "derivedBytes"
      FROM users u
      LEFT JOIN (
        SELECT fi."createdBy", SUM(fi."sizeBytes") AS total, MAX(fi."createdAt") AS "lastCreatedAt"
        FROM files fi
        LEFT JOIN drives d ON d.id = fi."driveId"
        WHERE fi."createdBy" IS NOT NULL
          -- WAL-9, O-9: org-drive bytes bill the org, never the uploader's personal quota.
          AND d."orgId" IS NULL
        GROUP BY fi."createdBy"
      ) f ON f."createdBy" = u.id
      WHERE ABS(ROUND(u."storageUsedBytes") - COALESCE(f.total, 0)) > ${Math.max(0, Math.round(toleranceBytes))}
        AND (f."lastCreatedAt" IS NULL OR f."lastCreatedAt" < now() - make_interval(secs => ${Math.max(0, cooldownSeconds)}))
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

  /**
   * #2225 review (Codex round 5) — the single-user admin reconcile reads
   * `users.storageUsedBytes` and sums `files.sizeBytes` as two separate
   * queries, the same TOCTOU window `findStorageDriftCandidates`'s cooldown
   * closes for the cron sweep: if a `files` row commits between those two
   * reads (upload/complete's insert lands but its separate storageUsedBytes
   * update hasn't yet), the derived sum already includes it while the cached
   * counter doesn't, so the delta correction double-counts it once the
   * upload's own pending update lands. Callers use this to skip correcting
   * a user whose most recent `files` row is too fresh, mirroring the cron's
   * cooldown for the same race on the single-user path.
   */
  findLastFileCreatedAtForUser: async (userId: string): Promise<Date | null> => {
    const [row] = await db
      .select({ createdAt: files.createdAt })
      .from(files)
      .where(eq(files.createdBy, userId))
      .orderBy(desc(files.createdAt))
      .limit(1);
    return row?.createdAt ?? null;
  },

  /**
   * The drives whose FILE pages count against the user's personal file-count limit: the ones
   * they own that are not org drives (an org drive's files count against the org, WAL-9).
   */
  findUserDriveIds: async (userId: string): Promise<string[]> => {
    const userDrives = await db.query.drives.findMany({
      where: and(eq(drives.ownerId, userId), isNull(drives.orgId)),
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
      .leftJoin(drives, eq(drives.id, files.driveId))
      .where(and(eq(files.createdBy, userId), personallyAttributed));
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

  /** The drive's orgId; undefined when the drive does not exist. */
  findDriveOrgId: async (driveId: string): Promise<string | null | undefined> => {
    const [row] = await db.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, driveId)).limit(1);
    return row ? row.orgId : undefined;
  },

  /** An org's derived storage usage: SUM(files.sizeBytes) over files in its drives (WAL-9). */
  sumOrgFileBytes: async (orgId: string): Promise<number> => {
    const [row] = await db
      .select({ total: sql<string | number | null>`COALESCE(SUM(${files.sizeBytes}), 0)` })
      .from(files)
      .innerJoin(drives, eq(drives.id, files.driveId))
      .where(eq(drives.orgId, orgId));
    return Number(row?.total ?? 0);
  },

  findOrgDriveIds: async (orgId: string): Promise<string[]> => {
    const rows = await db.select({ id: drives.id }).from(drives).where(eq(drives.orgId, orgId));
    return rows.map((r: { id: string }) => r.id);
  },

  /** drives.orgId for each existing drive among `driveIds` (a missing drive is absent). */
  findDriveOrgIds: async (driveIds: string[]): Promise<Map<string, string | null>> => {
    if (driveIds.length === 0) return new Map();
    const rows = await db.select({ id: drives.id, orgId: drives.orgId }).from(drives).where(inArray(drives.id, driveIds));
    return new Map(rows.map((r: { id: string; orgId: string | null }) => [r.id, r.orgId]));
  },

  /** One drive's files rows, read inside the move's transaction (O-9 re-attribution). */
  findDriveFileBytesInTx: async (tx: DrizzleTx, driveId: string): Promise<DriveFileBytes[]> => {
    const rows = await tx
      .select({ createdBy: files.createdBy, sizeBytes: files.sizeBytes })
      .from(files)
      .where(eq(files.driveId, driveId));
    return rows.map((r: { createdBy: string | null; sizeBytes: number | string | null }) => ({
      createdBy: r.createdBy,
      sizeBytes: typeof r.sizeBytes === 'string' ? Number(r.sizeBytes) : (r.sizeBytes ?? 0),
    }));
  },

  /** Insert storage events in chunks: one statement per ~500 rows stays far below 65535 binds. */
  insertStorageEventsInTx: async (
    tx: DrizzleTx,
    events: Array<typeof storageEvents.$inferInsert>,
  ): Promise<void> => {
    for (let i = 0; i < events.length; i += STORAGE_EVENT_CHUNK) {
      await tx.insert(storageEvents).values(events.slice(i, i + STORAGE_EVENT_CHUNK));
    }
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

  runTransaction: <T>(fn: (tx: DrizzleTx) => Promise<T>): Promise<T> => {
    return db.transaction(fn);
  },
};
