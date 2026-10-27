/**
 * Imperative shell for TTL'd pending-upload rows (#2154). One row is inserted
 * per presign-reserved slot (keyed by the semaphore jobId), deleted at
 * complete/cancel/stale-sweep, and counted (unexpired only) to enforce the
 * per-user concurrent-upload limit. See pending-uploads-core for the rules.
 */

import { db } from '@pagespace/db/db';
import { and, eq, gt, lt, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { pendingUploads } from '@pagespace/db/schema/storage';
import { pendingUploadExpiresAt, canStartUpload } from './pending-uploads-core';

export const pendingUploadsRepository = {
  /**
   * #2225 review — atomically check-and-reserve: count this user's live rows
   * and insert the new one in the SAME transaction, serialized by a row lock
   * on the user's own `users` row. Without this, two concurrent presigns for
   * the same user landing on different web replicas can both read the same
   * live count, both see it under the limit, and both insert — exceeding the
   * tier's concurrency cap by however many requests race.
   *
   * `SELECT ... FOR UPDATE` BLOCKS a second concurrent transaction for the
   * same user until the first commits, rather than failing it outright (the
   * semantics a Postgres advisory try-lock would give) — a legitimate
   * multi-file burst from one browser tab queues briefly instead of some of
   * its requests spuriously getting rejected. Different users never contend:
   * each locks only their own row.
   */
  reserveIfUnderLimit: async (params: {
    id: string;
    userId: string;
    fileSize: number;
    maxConcurrentUploads: number;
    now: Date;
  }): Promise<boolean> => {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${params.userId} FOR UPDATE`);

      const live = await tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(pendingUploads)
        .where(and(eq(pendingUploads.userId, params.userId), gt(pendingUploads.expiresAt, params.now)));
      const liveCount = Number(live[0]?.count ?? 0);

      if (!canStartUpload(liveCount, params.maxConcurrentUploads)) return false;

      await tx.insert(pendingUploads).values({
        id: params.id,
        userId: params.userId,
        fileSize: params.fileSize,
        expiresAt: pendingUploadExpiresAt(params.now.getTime()),
      });
      return true;
    });
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

/**
 * Atomically check the user's live-upload count against `maxConcurrentUploads`
 * and reserve a slot in one step. Returns false (no row inserted) when the
 * user is already at their limit. See
 * `pendingUploadsRepository.reserveIfUnderLimit` for why this must be one
 * atomic operation rather than a separate count-then-insert.
 */
export async function reserveUploadSlot(
  id: string,
  userId: string,
  fileSize: number,
  maxConcurrentUploads: number,
  now: Date = new Date(),
): Promise<boolean> {
  return pendingUploadsRepository.reserveIfUnderLimit({ id, userId, fileSize, maxConcurrentUploads, now });
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
