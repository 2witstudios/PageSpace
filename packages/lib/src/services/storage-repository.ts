/**
 * Storage Repository - Database access layer for storage operations.
 * Provides a clean seam for testing storage-limits without ORM chain mocks.
 */

import { db, users, pages, drives, storageEvents, eq, sql, and, inArray } from '@pagespace/db';

export type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface StorageUserRecord {
  id: string;
  storageUsedBytes: number;
  subscriptionTier: string | null;
}

export interface UploadUserRecord {
  activeUploads: number;
  subscriptionTier: string | null;
}

export const storageRepository = {
  findUserForStorage: async (userId: string): Promise<StorageUserRecord | undefined> => {
    return db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, storageUsedBytes: true, subscriptionTier: true },
    }) as Promise<StorageUserRecord | undefined>;
  },

  findUserForUploads: async (userId: string): Promise<UploadUserRecord | undefined> => {
    return db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { activeUploads: true, subscriptionTier: true },
    }) as Promise<UploadUserRecord | undefined>;
  },

  findUserDriveIds: async (userId: string): Promise<string[]> => {
    const userDrives = await db.query.drives.findMany({
      where: eq(drives.ownerId, userId),
      columns: { id: true },
    });
    return userDrives.map((d: { id: string }) => d.id);
  },

  sumFileSize: async (driveIds: string[]): Promise<number> => {
    const result = await db
      .select({ totalSize: sql<number>`COALESCE(SUM(CAST(${pages.fileSize} AS BIGINT)), 0)` })
      .from(pages)
      .where(and(
        inArray(pages.driveId, driveIds),
        eq(pages.type, 'FILE'),
        eq(pages.isTrashed, false),
      ));
    return Number(result[0]?.totalSize || 0);
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
    return Number(result[0]?.count || 0);
  },

  updateActiveUploads: async (userId: string, delta: number): Promise<void> => {
    await db.update(users)
      .set({ activeUploads: sql`GREATEST(0, COALESCE("activeUploads", 0) + ${delta})` })
      .where(eq(users.id, userId));
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
    return { newUsage: updatedUser.newUsage || 0 };
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
