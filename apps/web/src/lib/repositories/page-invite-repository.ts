/**
 * Repository for page-share-by-email invitation database operations.
 * Mirrors the shape of `drive-invite-repository.ts`.
 *
 * Page-invite acceptance is membership-coupled: granting a page permission
 * to a user who is not a drive member would leave the user with a pagePermissions
 * row in a drive whose tree they cannot navigate. `consumeInviteAndGrantPage`
 * therefore writes the drive_members row (as MEMBER, if missing) AND the
 * pagePermissions row in a single transaction.
 */

import { db } from '@pagespace/db/db'
import { eq, and, gt, lte, isNull } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { drives, pages } from '@pagespace/db/schema/core'
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import {
  pendingPageInvites,
  type PendingPagePermission,
} from '@pagespace/db/schema/pending-page-invites';

const PAGE_PERMISSION_FLAGS = (
  permissions: PendingPagePermission[],
): { canView: boolean; canEdit: boolean; canShare: boolean } => ({
  canView: permissions.includes('VIEW'),
  canEdit: permissions.includes('EDIT'),
  canShare: permissions.includes('SHARE'),
});

export const pageInviteRepository = {
  async findPendingInviteByTokenHash(tokenHash: string): Promise<{
    id: string;
    email: string;
    pageId: string;
    pageTitle: string;
    driveId: string;
    driveName: string;
    permissions: PendingPagePermission[];
    invitedBy: string;
    expiresAt: Date;
    consumedAt: Date | null;
  } | null> {
    const results = await db
      .select({
        id: pendingPageInvites.id,
        email: pendingPageInvites.email,
        pageId: pendingPageInvites.pageId,
        pageTitle: pages.title,
        driveId: pages.driveId,
        driveName: drives.name,
        permissions: pendingPageInvites.permissions,
        invitedBy: pendingPageInvites.invitedBy,
        expiresAt: pendingPageInvites.expiresAt,
        consumedAt: pendingPageInvites.consumedAt,
      })
      .from(pendingPageInvites)
      .innerJoin(pages, eq(pages.id, pendingPageInvites.pageId))
      .innerJoin(drives, eq(drives.id, pages.driveId))
      .where(eq(pendingPageInvites.tokenHash, tokenHash))
      .limit(1);
    return results.at(0) ?? null;
  },

  async createPendingInvite(input: {
    tokenHash: string;
    email: string;
    pageId: string;
    permissions: PendingPagePermission[];
    invitedBy: string;
    expiresAt: Date;
    now: Date;
  }) {
    const { tokenHash, email, pageId, permissions, invitedBy, expiresAt, now } = input;
    return db.transaction(async (tx) => {
      // Sweep already-expired unconsumed rows for this (pageId, email) pair so
      // the partial unique index does not block a legitimate re-invite. The
      // route-level pre-check filters active rows.
      await tx.delete(pendingPageInvites).where(
        and(
          eq(pendingPageInvites.pageId, pageId),
          eq(pendingPageInvites.email, email),
          isNull(pendingPageInvites.consumedAt),
          lte(pendingPageInvites.expiresAt, now),
        )
      );
      const [row] = await tx
        .insert(pendingPageInvites)
        .values({ tokenHash, email, pageId, permissions, invitedBy, expiresAt })
        .returning();
      return row;
    });
  },

  async deletePendingInvite(inviteId: string): Promise<void> {
    await db.delete(pendingPageInvites).where(eq(pendingPageInvites.id, inviteId));
  },

  async findActivePendingInviteByPageAndEmail(
    pageId: string,
    email: string,
    now: Date,
  ): Promise<{ id: string } | null> {
    const results = await db
      .select({ id: pendingPageInvites.id })
      .from(pendingPageInvites)
      .where(
        and(
          eq(pendingPageInvites.pageId, pageId),
          eq(pendingPageInvites.email, email),
          isNull(pendingPageInvites.consumedAt),
          gt(pendingPageInvites.expiresAt, now),
        )
      )
      .limit(1);
    return results.at(0) ?? null;
  },

  async findExistingPagePermission(pageId: string, userId: string) {
    const results = await db
      .select({ id: pagePermissions.id })
      .from(pagePermissions)
      .where(
        and(eq(pagePermissions.pageId, pageId), eq(pagePermissions.userId, userId)),
      )
      .limit(1);
    return results.at(0) ?? null;
  },

  async findUnconsumedActiveInvitesByEmail(
    email: string,
    now: Date,
  ): Promise<Array<{
    id: string;
    pageId: string;
    invitedBy: string;
    permissions: PendingPagePermission[];
  }>> {
    return db
      .select({
        id: pendingPageInvites.id,
        pageId: pendingPageInvites.pageId,
        invitedBy: pendingPageInvites.invitedBy,
        permissions: pendingPageInvites.permissions,
      })
      .from(pendingPageInvites)
      .where(
        and(
          eq(pendingPageInvites.email, email),
          isNull(pendingPageInvites.consumedAt),
          gt(pendingPageInvites.expiresAt, now),
        ),
      );
  },

  // Membership-coupled write: ensure drive_members row, then insert
  // page_permissions row, atomically with the consume of pendingPageInvites.
  async consumeInviteAndGrantPage(input: {
    inviteId: string;
    pageId: string;
    driveId: string;
    userId: string;
    permissions: PendingPagePermission[];
    invitedBy: string;
    grantedAt: Date;
  }): Promise<
    | { ok: true; memberId: string | null }
    | { ok: false; reason: 'TOKEN_CONSUMED' | 'ALREADY_HAS_PERMISSION' }
  > {
    const ALREADY_HAS_PERMISSION = Symbol('ALREADY_HAS_PERMISSION');
    try {
      const memberId = await db.transaction(async (tx) => {
        const consumed = await tx
          .update(pendingPageInvites)
          .set({ consumedAt: input.grantedAt })
          .where(
            and(
              eq(pendingPageInvites.id, input.inviteId),
              isNull(pendingPageInvites.consumedAt),
            ),
          )
          .returning({ id: pendingPageInvites.id });
        if (consumed.length === 0) {
          throw 'TOKEN_CONSUMED';
        }

        // Ensure drive_members row exists. Page access without drive
        // membership is incoherent — see the design plan in
        // every-invite-flow-should-ancient-zebra.md.
        const existingMember = await tx
          .select({ id: driveMembers.id })
          .from(driveMembers)
          .where(
            and(
              eq(driveMembers.driveId, input.driveId),
              eq(driveMembers.userId, input.userId),
            ),
          )
          .limit(1);

        let createdMemberId: string | null = null;
        if (existingMember.length === 0) {
          const [member] = await tx
            .insert(driveMembers)
            .values({
              driveId: input.driveId,
              userId: input.userId,
              role: 'MEMBER',
              invitedBy: input.invitedBy,
              acceptedAt: input.grantedAt,
            })
            .returning({ id: driveMembers.id });
          createdMemberId = member.id;
        }

        const flags = PAGE_PERMISSION_FLAGS(input.permissions);
        try {
          await tx.insert(pagePermissions).values({
            pageId: input.pageId,
            userId: input.userId,
            canView: flags.canView,
            canEdit: flags.canEdit,
            canShare: flags.canShare,
            canDelete: false,
            grantedBy: input.invitedBy,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isUniqueViolation =
            message.includes('page_permissions_page_user_key') ||
            (message.includes('duplicate key') && message.includes('page_permissions'));
          if (isUniqueViolation) {
            throw ALREADY_HAS_PERMISSION;
          }
          throw error;
        }

        return createdMemberId;
      });
      return { ok: true, memberId };
    } catch (error) {
      if (error === 'TOKEN_CONSUMED') {
        return { ok: false, reason: 'TOKEN_CONSUMED' };
      }
      if (error === ALREADY_HAS_PERMISSION) {
        return { ok: false, reason: 'ALREADY_HAS_PERMISSION' };
      }
      throw error;
    }
  },

  async findInviterDisplay(userId: string): Promise<{ name: string; email: string } | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, email: true },
    });
    return user ? { name: user.name, email: user.email } : null;
  },
};

export type PageInviteRepository = typeof pageInviteRepository;
