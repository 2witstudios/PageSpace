/**
 * The PageSpace facts the account authority reads around an account (L2·G2) —
 * I/O only, through the centralized permission functions (CLAUDE.md: never
 * roll your own): the page's drive, the HUMAN's drive role, the human's page
 * permission, and the drive's OWNER/ADMIN set pinned as consenters at first
 * put (G1c R2). Nothing here decides access; `authorize`,
 * `decideAccountAccess` and `decideAccountCreatePermission` do.
 */
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { getDriveAccess } from '../services/drive-service';
import { canUserEditPage, canUserViewPage } from '../permissions/permissions';
import { listDriveAudience } from '../permissions/drive-audience';
import type { DriveRoleOfHuman } from '../permissions/account-permissions';
import type { UserId } from './grant';

/** A drive's admin list is small; this bounds a pathological one. */
const MAX_CONSENTERS = 100;

export type AccountFactsRepository = {
  /** The drive of a live (untrashed) page; null when it does not exist. */
  readonly pageDrive: (pageId: string) => Promise<string | null>;
  readonly driveRole: (input: { readonly driveId: string; readonly userId: string }) => Promise<DriveRoleOfHuman>;
  /** The drive owner and its effective ADMINs, sorted — the consenters an agent-page account pins. */
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

    // Who is a drive's admin is a membership answer, so it comes from the permissions layer's
    // audience (the same effective membership getDriveAccess gives driveRole): a pending invite
    // or a stale org row is no admin, and an org Owner/Admin's power on an org drive is one.
    async driveConsenters(driveId) {
      const audience = await listDriveAudience(driveId);
      const owner = audience.filter((member) => member.isOwner).map((member) => member.userId);
      const admins = audience
        .filter((member) => !member.isOwner && member.role === 'ADMIN')
        .map((member) => member.userId)
        .sort()
        .slice(0, MAX_CONSENTERS);
      const ids = new Set<string>([...owner, ...admins]);
      return [...ids].sort() as UserId[];
    },

    async pagePermission({ userId, pageId }) {
      if (await canUserEditPage(userId, pageId)) return 'edit';
      return (await canUserViewPage(userId, pageId)) ? 'view' : 'none';
    },
  };
}
