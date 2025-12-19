/**
 * Drive Repository - Clean seam for drive operations
 *
 * Provides testable boundary for drive-related database operations.
 * Tests should mock this repository, not the ORM chains.
 */

import { db, drives, eq, and } from '@pagespace/db';

// Types for repository operations
export interface DriveRecord {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  isTrashed: boolean;
  trashedAt: Date | null;
}

export interface DriveBasic {
  id: string;
  ownerId: string;
}

export const driveRepository = {
  /**
   * Find a drive by ID
   */
  findById: async (driveId: string): Promise<DriveRecord | null> => {
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
    });

    return drive as DriveRecord | null;
  },

  /**
   * Find a drive by ID with basic info (for permission checks)
   */
  findByIdBasic: async (driveId: string): Promise<DriveBasic | null> => {
    const [drive] = await db
      .select({ id: drives.id, ownerId: drives.ownerId })
      .from(drives)
      .where(eq(drives.id, driveId));

    return drive ?? null;
  },

  /**
   * Find a drive by ID owned by a specific user
   */
  findByIdAndOwner: async (
    driveId: string,
    ownerId: string
  ): Promise<DriveRecord | null> => {
    const drive = await db.query.drives.findFirst({
      where: and(eq(drives.id, driveId), eq(drives.ownerId, ownerId)),
    });

    return drive as DriveRecord | null;
  },

  /**
   * Trash a drive (soft delete)
   */
  trash: async (driveId: string): Promise<void> => {
    await db
      .update(drives)
      .set({
        isTrashed: true,
        trashedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(drives.id, driveId));
  },

  /**
   * Restore a drive from trash
   */
  restore: async (
    driveId: string
  ): Promise<{ id: string; name: string; slug: string }> => {
    const [restoredDrive] = await db
      .update(drives)
      .set({
        isTrashed: false,
        trashedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(drives.id, driveId))
      .returning({ id: drives.id, name: drives.name, slug: drives.slug });

    return restoredDrive;
  },
};

export type DriveRepository = typeof driveRepository;
