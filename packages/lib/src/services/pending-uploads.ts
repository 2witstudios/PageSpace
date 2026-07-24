/**
 * Imperative shell for TTL'd pending-upload rows (#2154). One row is inserted
 * per presign-reserved slot (keyed by the semaphore jobId), deleted at
 * complete/cancel/stale-sweep, and counted (unexpired only) to enforce the
 * per-user concurrent-upload limit. See pending-uploads-core for the rules.
 */

import { db } from '@pagespace/db/db';
import { and, eq, gt, lt, sql } from '@pagespace/db/operators';
import { pendingUploads } from '@pagespace/db/schema/storage';
import { pendingUploadExpiresAt } from './pending-uploads-core';

export const pendingUploadsRepository = {
  /** Reserve an in-flight upload: one row per presign, keyed by the slot id. */
  insert: async (row: { id: string; userId: string; fileSize: number; expiresAt: Date }): Promise<void> => {
    await db.insert(pendingUploads).values(row);
  },

  /** Release a reservation. Idempotent — deleting a missing/expired row is a no-op. */
  deleteById: async (id: string): Promise<void> => {
    await db.delete(pendingUploads).where(eq(pendingUploads.id, id));
  },

  /** Live (unexpired) reservations currently held by a user. */
  countLiveForUser: async (userId: string, now: Date): Promise<number> => {
    const result = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(pendingUploads)
      .where(and(eq(pendingUploads.userId, userId), gt(pendingUploads.expiresAt, now)));
    return Number(result[0]?.count ?? 0);
  },

  /** TTL reaper: drop rows whose expiry has passed. Returns rows deleted. */
  deleteExpired: async (now: Date): Promise<number> => {
    const result = await db.delete(pendingUploads).where(lt(pendingUploads.expiresAt, now));
    return result.rowCount ?? 0;
  },
};

/** Record a presign-reserved upload; it holds a concurrency slot until released or expired. */
export async function registerPendingUpload(
  id: string,
  userId: string,
  fileSize: number,
  now: Date = new Date(),
): Promise<void> {
  await pendingUploadsRepository.insert({
    id,
    userId,
    fileSize,
    expiresAt: pendingUploadExpiresAt(now.getTime()),
  });
}

/**
 * Release a reservation (complete, cancel, or stale-slot sweep). Idempotent by
 * construction, so the multiple release paths in the upload routes can't
 * double-release the way the old counter could double-decrement.
 */
export async function releasePendingUpload(id: string): Promise<void> {
  await pendingUploadsRepository.deleteById(id);
}

/** Live in-flight upload count for a user — the derived replacement for users.activeUploads. */
export async function countLiveUploadsForUser(userId: string, now: Date = new Date()): Promise<number> {
  return pendingUploadsRepository.countLiveForUser(userId, now);
}

/** Reap expired reservations (sweep-expired cron). Returns rows deleted. */
export async function sweepExpiredPendingUploads(now: Date = new Date()): Promise<number> {
  return pendingUploadsRepository.deleteExpired(now);
}
