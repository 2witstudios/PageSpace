/**
 * Repository for drive member invitation database operations.
 * This seam isolates query-builder details from the invite route handler,
 * enabling proper unit testing without ORM chain mocking.
 */

import { db } from '@pagespace/db/db'
import { eq, and, gt, lte, isNotNull, isNull } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { drives, pages } from '@pagespace/db/schema/core'
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { pendingInvites } from '@pagespace/db/schema/pending-invites';

export const driveInviteRepository = {
  async findDriveById(driveId: string) {
    const results = await db
      .select()
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);
    return results.at(0) ?? null;
  },

  async findAdminMembership(driveId: string, userId: string) {
    // Match the acceptedAt-IS-NOT-NULL gate used by checkDriveAccess so a
    // pending invitee with role 'ADMIN' cannot exercise admin powers (sending
    // further invites, resending invites) before they themselves complete the
    // invitation acceptance flow.
    const results = await db
      .select()
      .from(driveMembers)
      .where(
        and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, userId),
          eq(driveMembers.role, 'ADMIN'),
          isNotNull(driveMembers.acceptedAt)
        )
      )
      .limit(1);
    return results.at(0) ?? null;
  },

  async findExistingMember(driveId: string, userId: string) {
    const results = await db
      .select()
      .from(driveMembers)
      .where(
        and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, userId)
        )
      )
      .limit(1);
    return results.at(0) ?? null;
  },

  async createDriveMember(data: {
    driveId: string;
    userId: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    customRoleId: string | null;
    invitedBy: string;
    acceptedAt: Date | null;
  }) {
    const results = await db
      .insert(driveMembers)
      .values(data)
      .returning();
    return results[0];
  },

  async updateDriveMemberRole(
    memberId: string,
    role: 'OWNER' | 'ADMIN' | 'MEMBER',
    customRoleId: string | null
  ) {
    await db
      .update(driveMembers)
      .set({ role, customRoleId })
      .where(eq(driveMembers.id, memberId));
  },

  async getValidPageIds(driveId: string): Promise<string[]> {
    const results = await db
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.driveId, driveId));
    return results.map((p) => p.id);
  },

  async findPagePermission(pageId: string, userId: string) {
    const results = await db
      .select()
      .from(pagePermissions)
      .where(
        and(
          eq(pagePermissions.pageId, pageId),
          eq(pagePermissions.userId, userId)
        )
      )
      .limit(1);
    return results.at(0) ?? null;
  },

  async createPagePermission(data: {
    pageId: string;
    userId: string;
    canView: boolean;
    canEdit: boolean;
    canShare: boolean;
    canDelete: boolean;
    grantedBy: string;
  }) {
    const results = await db
      .insert(pagePermissions)
      .values(data)
      .returning();
    return results[0];
  },

  async updatePagePermission(
    permId: string,
    data: {
      canView: boolean;
      canEdit: boolean;
      canShare: boolean;
      grantedBy: string;
      grantedAt: Date;
    }
  ) {
    const results = await db
      .update(pagePermissions)
      .set(data)
      .where(eq(pagePermissions.id, permId))
      .returning();
    return results[0];
  },

  async findUserEmail(userId: string): Promise<string | undefined> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { email: true },
    });
    return user?.email;
  },

  async findUserIdByEmail(
    email: string
  ): Promise<{ id: string; emailVerified: Date | null; suspendedAt: Date | null } | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true, emailVerified: true, suspendedAt: true },
    });
    return user
      ? { id: user.id, emailVerified: user.emailVerified, suspendedAt: user.suspendedAt }
      : null;
  },

  async findUserVerificationStatusById(
    userId: string
  ): Promise<{ email: string; emailVerified: Date | null; suspendedAt: Date | null } | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { email: true, emailVerified: true, suspendedAt: true },
    });
    return user
      ? { email: user.email, emailVerified: user.emailVerified, suspendedAt: user.suspendedAt }
      : null;
  },

  async findActivePendingMemberByEmail(driveId: string, email: string): Promise<{ id: string } | null> {
    const results = await db
      .select({ id: driveMembers.id })
      .from(driveMembers)
      .innerJoin(users, eq(users.id, driveMembers.userId))
      .where(
        and(
          eq(driveMembers.driveId, driveId),
          eq(users.email, email),
          isNull(driveMembers.acceptedAt)
        )
      )
      .limit(1);
    return results.at(0) ?? null;
  },

  async findInviterDisplay(userId: string): Promise<{ name: string; email: string } | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, email: true },
    });
    return user ? { name: user.name, email: user.email } : null;
  },

  async deleteDriveMemberById(memberId: string): Promise<void> {
    await db.delete(driveMembers).where(eq(driveMembers.id, memberId));
  },

  async createAcceptedMemberWithPermissions(input: {
    driveId: string;
    userId: string;
    role: 'MEMBER' | 'ADMIN';
    customRoleId: string | null;
    invitedBy: string;
    permissions: Array<{ pageId: string; canView: boolean; canEdit: boolean; canShare: boolean }>;
    grantedBy: string;
    validPageIds: Set<string>;
  }): Promise<{ memberId: string; permissionsGranted: number }> {
    return db.transaction(async (tx) => {
      const [member] = await tx
        .insert(driveMembers)
        .values({
          driveId: input.driveId,
          userId: input.userId,
          role: input.role,
          customRoleId: input.customRoleId,
          invitedBy: input.invitedBy,
          acceptedAt: new Date(),
        })
        .returning();

      let permissionsGranted = 0;
      for (const perm of input.permissions) {
        if (!input.validPageIds.has(perm.pageId)) continue;
        await tx.insert(pagePermissions).values({
          pageId: perm.pageId,
          userId: input.userId,
          canView: perm.canView,
          canEdit: perm.canEdit,
          canShare: perm.canShare,
          canDelete: false,
          grantedBy: input.grantedBy,
        });
        permissionsGranted += 1;
      }

      return { memberId: member.id, permissionsGranted };
    });
  },

  async createPendingInvite(input: {
    tokenHash: string;
    email: string;
    driveId: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    invitedBy: string;
    expiresAt: Date;
    now: Date;
  }) {
    const { tokenHash, email, driveId, role, invitedBy, expiresAt, now } = input;
    return db.transaction(async (tx) => {
      // Sweep any already-expired unconsumed row for this (driveId, email) pair
      // so the partial unique index does not block a legitimate re-invite.
      // Active (unexpired) rows are caught by the route's pre-check + the
      // unique index itself surfacing as a constraint violation.
      await tx.delete(pendingInvites).where(
        and(
          eq(pendingInvites.driveId, driveId),
          eq(pendingInvites.email, email),
          isNull(pendingInvites.consumedAt),
          lte(pendingInvites.expiresAt, now),
        )
      );
      const [row] = await tx
        .insert(pendingInvites)
        .values({ tokenHash, email, driveId, role, invitedBy, expiresAt })
        .returning();
      return row;
    });
  },

  async findPendingInviteByTokenHash(tokenHash: string): Promise<{
    id: string;
    email: string;
    driveId: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    invitedBy: string;
    expiresAt: Date;
    consumedAt: Date | null;
    driveName: string;
    inviterName: string;
  } | null> {
    const results = await db
      .select({
        id: pendingInvites.id,
        email: pendingInvites.email,
        driveId: pendingInvites.driveId,
        role: pendingInvites.role,
        invitedBy: pendingInvites.invitedBy,
        expiresAt: pendingInvites.expiresAt,
        consumedAt: pendingInvites.consumedAt,
        driveName: drives.name,
        inviterName: users.name,
      })
      .from(pendingInvites)
      .innerJoin(drives, eq(drives.id, pendingInvites.driveId))
      .innerJoin(users, eq(users.id, pendingInvites.invitedBy))
      .where(eq(pendingInvites.tokenHash, tokenHash))
      .limit(1);
    return results.at(0) ?? null;
  },

  async findActivePendingInviteByDriveAndEmail(
    driveId: string,
    email: string,
    now: Date,
  ): Promise<{ id: string } | null> {
    const results = await db
      .select({ id: pendingInvites.id })
      .from(pendingInvites)
      .where(
        and(
          eq(pendingInvites.driveId, driveId),
          eq(pendingInvites.email, email),
          isNull(pendingInvites.consumedAt),
          gt(pendingInvites.expiresAt, now),
        )
      )
      .limit(1);
    return results.at(0) ?? null;
  },

  async markInviteConsumed({ inviteId, now }: { inviteId: string; now: Date }): Promise<boolean> {
    const updated = await db
      .update(pendingInvites)
      .set({ consumedAt: now })
      .where(
        and(
          eq(pendingInvites.id, inviteId),
          isNull(pendingInvites.consumedAt),
        )
      )
      .returning({ id: pendingInvites.id });
    return updated.length > 0;
  },

  async deletePendingInvite(inviteId: string): Promise<void> {
    await db.delete(pendingInvites).where(eq(pendingInvites.id, inviteId));
  },

  async loadUserAccountByEmail(
    email: string,
  ): Promise<{ id: string; suspendedAt: Date | null } | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email.trim().toLowerCase()),
      columns: { id: true, suspendedAt: true },
    });
    return user ? { id: user.id, suspendedAt: user.suspendedAt } : null;
  },

  // Lists every unconsumed pending invite for the drive, INCLUDING expired
  // rows. The pending-invites UI (PR 2) needs to show stale-but-stuck invites
  // so admins can revoke them; the validator/route layer is where expiry-based
  // policy decisions belong, not the loader. Contrast with
  // `findActivePendingInviteByDriveAndEmail` which is the strict-active gate
  // for "is there a fresh in-flight invite for this address" — that one DOES
  // filter `expiresAt > now`.
  // Returns every active (unconsumed, unexpired) drive-invite row for the
  // given email, joined with drive name + role + inviter — used by the
  // post-signup multi-invite auto-accept helper. The dispatcher needs this
  // metadata for the membership-added side-effect payload, and folding it
  // into the same lookup avoids a per-invite hydration round-trip.
  async findUnconsumedActiveInvitesByEmail(
    email: string,
    now: Date,
  ): Promise<Array<{
    id: string;
    driveId: string;
    driveName: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    invitedBy: string;
  }>> {
    return db
      .select({
        id: pendingInvites.id,
        driveId: pendingInvites.driveId,
        driveName: drives.name,
        role: pendingInvites.role,
        invitedBy: pendingInvites.invitedBy,
      })
      .from(pendingInvites)
      .innerJoin(drives, eq(drives.id, pendingInvites.driveId))
      .where(
        and(
          eq(pendingInvites.email, email),
          isNull(pendingInvites.consumedAt),
          gt(pendingInvites.expiresAt, now),
        ),
      );
  },

  async findUnconsumedInvitesByDrive(driveId: string): Promise<Array<{
    id: string;
    email: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    driveId: string;
    invitedByName: string;
    createdAt: Date;
    expiresAt: Date;
  }>> {
    return db
      .select({
        id: pendingInvites.id,
        email: pendingInvites.email,
        role: pendingInvites.role,
        driveId: pendingInvites.driveId,
        invitedByName: users.name,
        createdAt: pendingInvites.createdAt,
        expiresAt: pendingInvites.expiresAt,
      })
      .from(pendingInvites)
      .innerJoin(users, eq(users.id, pendingInvites.invitedBy))
      .where(
        and(
          eq(pendingInvites.driveId, driveId),
          isNull(pendingInvites.consumedAt),
        ),
      );
  },

  // Loader for the revoke route (PR 2). Returns expired-unconsumed rows too
  // so revoke can clean them up; expiry-policy lives at the validator layer.
  async findUnconsumedInviteForDrive(input: {
    inviteId: string;
    driveId: string;
  }): Promise<{ id: string; email: string; role: 'OWNER' | 'ADMIN' | 'MEMBER'; driveId: string } | null> {
    const rows = await db
      .select({
        id: pendingInvites.id,
        email: pendingInvites.email,
        role: pendingInvites.role,
        driveId: pendingInvites.driveId,
      })
      .from(pendingInvites)
      .where(
        and(
          eq(pendingInvites.id, input.inviteId),
          eq(pendingInvites.driveId, input.driveId),
          isNull(pendingInvites.consumedAt),
        ),
      )
      .limit(1);
    return rows.at(0) ?? null;
  },

  async deletePendingInviteForDrive(input: {
    inviteId: string;
    driveId: string;
  }): Promise<{ rowsDeleted: number }> {
    const deleted = await db
      .delete(pendingInvites)
      .where(
        and(eq(pendingInvites.id, input.inviteId), eq(pendingInvites.driveId, input.driveId)),
      )
      .returning({ id: pendingInvites.id });
    return { rowsDeleted: deleted.length };
  },

  async consumeInviteAndCreateMembership(input: {
    inviteId: string;
    driveId: string;
    userId: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    invitedBy: string;
    acceptedAt: Date;
  }): Promise<
    | { ok: true; memberId: string }
    | { ok: false; reason: 'TOKEN_CONSUMED' | 'ALREADY_MEMBER' }
  > {
    const { inviteId, driveId, userId, role, invitedBy, acceptedAt } = input;
    // The ALREADY_MEMBER signal must roll back the consume — if the user is
    // already a member there is no reason to burn the invite token. We throw
    // a sentinel inside the transaction so Drizzle rolls back, then translate
    // it to a result outside the tx boundary.
    const ALREADY_MEMBER = Symbol('ALREADY_MEMBER');
    try {
      const memberId = await db.transaction(async (tx) => {
        const consumed = await tx
          .update(pendingInvites)
          .set({ consumedAt: acceptedAt })
          .where(
            and(
              eq(pendingInvites.id, inviteId),
              isNull(pendingInvites.consumedAt),
            )
          )
          .returning({ id: pendingInvites.id });

        if (consumed.length === 0) {
          // No rollback needed — nothing was written. Sentinel-throw so the
          // caller's result type can carry the discriminated reason.
          throw 'TOKEN_CONSUMED';
        }

        try {
          const [member] = await tx
            .insert(driveMembers)
            .values({ driveId, userId, role, invitedBy, acceptedAt })
            .returning({ id: driveMembers.id });
          return member.id;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isUniqueViolation =
            message.includes('drive_members_drive_user_key') ||
            (message.includes('duplicate key') && message.includes('drive_members'));
          if (isUniqueViolation) {
            // Throw the sentinel so the transaction rolls back the consume.
            throw ALREADY_MEMBER;
          }
          throw error;
        }
      });
      return { ok: true, memberId };
    } catch (error) {
      if (error === 'TOKEN_CONSUMED') {
        return { ok: false, reason: 'TOKEN_CONSUMED' };
      }
      if (error === ALREADY_MEMBER) {
        return { ok: false, reason: 'ALREADY_MEMBER' };
      }
      throw error;
    }
  },
};

export type DriveInviteRepository = typeof driveInviteRepository;
