/**
 * Account Repository - Clean seam for account operations
 *
 * Provides testable boundary for account-related database operations.
 * Tests should mock this repository, not the ORM chains.
 */

import { db, users, drives, driveMembers, eq, sql } from '@pagespace/db';

export interface UserAccount {
  id: string;
  email: string;
  image: string | null;
}

export interface OwnedDrive {
  id: string;
  name: string;
}

export interface DriveMemberCount {
  driveId: string;
  memberCount: number;
}

export const accountRepository = {
  /**
   * Find user by ID with fields needed for account deletion
   */
  findById: async (userId: string): Promise<UserAccount | null> => {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        email: true,
        image: true,
      },
    });

    return user ?? null;
  },

  /**
   * Get all drives owned by a user
   */
  getOwnedDrives: async (userId: string): Promise<OwnedDrive[]> => {
    return db.query.drives.findMany({
      where: eq(drives.ownerId, userId),
      columns: {
        id: true,
        name: true,
      },
    });
  },

  /**
   * Get member count for a drive
   */
  getDriveMemberCount: async (driveId: string): Promise<number> => {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(driveMembers)
      .where(eq(driveMembers.driveId, driveId));

    return Number(result[0]?.count || 0);
  },

  /**
   * Delete a drive by ID
   */
  deleteDrive: async (driveId: string): Promise<void> => {
    await db.delete(drives).where(eq(drives.id, driveId));
  },

  /**
   * Delete a user by ID
   */
  deleteUser: async (userId: string): Promise<void> => {
    await db.delete(users).where(eq(users.id, userId));
  },
};

export type AccountRepository = typeof accountRepository;
