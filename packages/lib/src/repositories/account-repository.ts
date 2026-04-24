/**
 * Account Repository - Clean seam for account operations
 *
 * Provides testable boundary for account-related database operations.
 * Tests should mock this repository, not the ORM chains.
 */

import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';

export interface UserAccount {
  id: string;
  email: string;
  image: string | null;
  stripeCustomerId: string | null;
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
        stripeCustomerId: true,
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

  /**
   * Atomically check owned drives and delete solo ones inside a transaction.
   * Returns multi-member drive names if any exist (caller should abort).
   */
  checkAndDeleteSoloDrives: async (userId: string): Promise<{ multiMemberDriveNames: string[] }> => {
    return db.transaction(async (tx) => {
      const ownedDrives = await tx.query.drives.findMany({
        where: eq(drives.ownerId, userId),
        columns: { id: true, name: true },
      });

      if (ownedDrives.length === 0) return { multiMemberDriveNames: [] };

      const multiMemberNames: string[] = [];
      const soloDriveIds: string[] = [];

      for (const drive of ownedDrives) {
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)` })
          .from(driveMembers)
          .where(eq(driveMembers.driveId, drive.id));

        if (Number(count) > 1) {
          multiMemberNames.push(drive.name);
        } else {
          soloDriveIds.push(drive.id);
        }
      }

      if (multiMemberNames.length > 0) {
        return { multiMemberDriveNames: multiMemberNames };
      }

      // Safe to delete — no multi-member drives
      for (const driveId of soloDriveIds) {
        await tx.delete(drives).where(eq(drives.id, driveId));
      }

      return { multiMemberDriveNames: [] };
    });
  },
};

export type AccountRepository = typeof accountRepository;
