/**
 * The PageSpace facts the account authority reads around an account (L2·G2) —
 * I/O only, through the centralized permission functions (CLAUDE.md: never
 * roll your own): the page's drive, the HUMAN's drive role, the human's page
 * permission, and the drive's OWNER/ADMIN set pinned as consenters at first
 * put (G1c R2). Nothing here decides access; `authorize`,
 * `decideAccountAccess` and `decideAccountCreatePermission` do.
 */
import { db } from '@pagespace/db/db';
import { and, eq, isNotNull } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { getDriveAccess } from '../services/drive-service';
import { canUserEditPage, canUserViewPage } from '../permissions/permissions';
import type { DriveRoleOfHuman } from '../permissions/account-permissions';
import type { UserId } from './grant';

/** A drive's admin list is small; this bounds a pathological one. */
const MAX_CONSENTERS = 100;

export type AccountFactsRepository = {
  /** The drive of a live (untrashed) page; null when it does not exist. */
  readonly pageDrive: (pageId: string) => Promise<string | null>;
  readonly driveRole: (input: { readonly driveId: string; readonly userId: string }) => Promise<DriveRoleOfHuman>;
  /** The drive owner and accepted ADMINs, sorted — the consenters an agent-page account pins. */
  readonly driveConsenters: (driveId: string) => Promise<readonly UserId[]>;
  readonly pagePermission: (input: { readonly userId: string; readonly pageId: string }) => Promise<'edit' | 'view' | 'none'>;
};

export function createAccountFactsRepository(): AccountFactsRepository {
  return {
    async pageDrive(pageId) {
      const rows = await db.select({ driveId: pages.driveId }).from(pages).where(and(eq(pages.id, pageId), eq(pages.isTrashed, false))).limit(1);
      return rows[0]?.driveId ?? null;
    },

    async driveRole({ driveId, userId }) {
      const access = await getDriveAccess(driveId, userId);
      return access.role === 'OWNER' || access.role === 'ADMIN' || access.role === 'MEMBER' ? access.role : null;
    },

    async driveConsenters(driveId) {
      const owner = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, driveId)).limit(1);
      const admins = await db
        .select({ userId: driveMembers.userId })
        .from(driveMembers)
        .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.role, 'ADMIN'), isNotNull(driveMembers.acceptedAt)))
        .limit(MAX_CONSENTERS);
      const ids = new Set<string>([...owner.map((row) => row.ownerId), ...admins.map((row) => row.userId)]);
      return [...ids].sort() as UserId[];
    },

    async pagePermission({ userId, pageId }) {
      if (await canUserEditPage(userId, pageId)) return 'edit';
      return (await canUserViewPage(userId, pageId)) ? 'view' : 'none';
    },
  };
}
