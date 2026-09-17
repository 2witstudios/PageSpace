/**
 * Account Repository - Clean seam for account operations
 *
 * Provides testable boundary for account-related database operations.
 * Tests should mock this repository, not the ORM chains.
 */

import { db } from '@pagespace/db/db';
import { and, eq, isNull, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { organizations } from '@pagespace/db/schema/organizations';
import { deleteConversationsForDrive } from './conversation-cleanup';
import { decryptUserRow } from '../auth/user-repository';
import { leaveAllOrganizations, reassignLedOrgDrives } from '../organizations/leave';
import { createAnonymizedActorEmail } from '../compliance/anonymize';

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

    // Decrypt PII at the edge so the email confirmation + erasure payload use plaintext.
    return user ? decryptUserRow(user) : null;
  },

  /**
   * Get the personal drives owned by a user. Org drives the user leads are not theirs to
   * dispose of: deleteUser reassigns them to the org Owner (Spec O-7).
   */
  getOwnedDrives: async (userId: string): Promise<OwnedDrive[]> => {
    return db.query.drives.findMany({
      where: and(eq(drives.ownerId, userId), isNull(drives.orgId)),
      columns: {
        id: true,
        name: true,
      },
    });
  },

  /**
   * Names of the organizations the user owns. An org Owner cannot delete their account (ORG-6):
   * every erasure entry point refuses on a non-empty list BEFORE destroying anything, since
   * deleteUser would otherwise refuse only at the very end, after the rest was erased.
   */
  getOwnedOrganizationNames: async (userId: string): Promise<string[]> => {
    const rows = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.ownerId, userId));
    return rows.map((r) => r.name);
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
   * Delete a drive by ID.
   *
   * Takes the drive's chat history with it, explicitly and first: the drive
   * cascade reaches `pages` and `drive_members` but NOT `conversations`, whose
   * `contextId` has never been a foreign key. The `chat_messages.pageId`
   * cascade that used to make this automatic went with the table in 0253.
   */
  deleteDrive: async (driveId: string): Promise<void> => {
    await db.transaction(async (tx) => {
      await deleteConversationsForDrive(tx, driveId);
      await tx.delete(drives).where(eq(drives.id, driveId));
    });
  },

  /**
   * Delete a user by ID.
   *
   * drives.ownerId cascades, so the user first leaves every org and any org drive they still
   * lead is reassigned to its org Owner, in the same transaction as the delete (Spec O-7, O-8).
   * An org Owner is refused (LeaveOrganizationRefusedError) and nothing changes: ownership
   * transfers first (ORG-6). The audit actor is the anonymized address, since this runs after
   * the erasure has anonymized the user's activity.
   */
  deleteUser: async (userId: string): Promise<void> => {
    await db.transaction(async (tx) => {
      const options = {
        reason: 'account_deleted' as const,
        actor: { actorEmail: createAnonymizedActorEmail(userId), actorDisplayName: 'Deleted User' },
      };
      await leaveAllOrganizations(userId, tx, options);
      // A lead who is somehow no longer a member of the drive's org still must not take it.
      await reassignLedOrgDrives(userId, tx, options);
      await tx.delete(users).where(eq(users.id, userId));
    });
  },

  /**
   * Atomically check owned drives and delete solo ones inside a transaction.
   * Returns multi-member drive names if any exist (caller should abort).
   */
  checkAndDeleteSoloDrives: async (userId: string): Promise<{ multiMemberDriveNames: string[] }> => {
    return db.transaction(async (tx) => {
      const ownedDrives = await tx.query.drives.findMany({
        where: and(eq(drives.ownerId, userId), isNull(drives.orgId)),
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

      // Safe to delete — no multi-member drives. Chat history first, while the
      // drive's pages still exist to trace the page-scoped threads through
      // (the drive cascade does not reach `conversations`).
      for (const driveId of soloDriveIds) {
        await deleteConversationsForDrive(tx, driveId);
        await tx.delete(drives).where(eq(drives.id, driveId));
      }

      return { multiMemberDriveNames: [] };
    });
  },
};

export type AccountRepository = typeof accountRepository;
