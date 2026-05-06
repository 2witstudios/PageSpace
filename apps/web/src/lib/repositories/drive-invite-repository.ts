/**
 * Repository for drive member invitation database operations.
 * This seam isolates query-builder details from the invite route handler,
 * enabling proper unit testing without ORM chain mocking.
 */

import { db } from '@pagespace/db/db'
import { eq, and, isNotNull, isNull } from '@pagespace/db/operators'
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

  async findUserToSStatusByEmail(email: string): Promise<{ tosAcceptedAt: Date | null } | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { tosAcceptedAt: true },
    });
    return user ? { tosAcceptedAt: user.tosAcceptedAt } : null;
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

  async findPendingMembersForUser(userId: string) {
    return db
      .select({
        id: driveMembers.id,
        driveId: driveMembers.driveId,
        role: driveMembers.role,
        driveName: drives.name,
      })
      .from(driveMembers)
      .innerJoin(drives, eq(drives.id, driveMembers.driveId))
      .where(
        and(
          eq(driveMembers.userId, userId),
          isNull(driveMembers.acceptedAt)
        )
      );
  },

  // REVIEW: confirm overwrite acceptable for compliance.
  // Overwrites the original invitedAt instead of persisting a separate
  // lastInvitedAt column. The product surface ("last sent N minutes ago")
  // only needs the most recent send time. If audit/legal later needs the
  // original-invite timestamp, add a lastInvitedAt column and stop overwriting.
  async bumpInvitedAt(memberId: string): Promise<void> {
    await db
      .update(driveMembers)
      .set({ invitedAt: new Date() })
      .where(eq(driveMembers.id, memberId));
  },

  async createPendingInvite(data: {
    tokenHash: string;
    email: string;
    driveId: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    invitedBy: string;
    expiresAt: Date;
  }) {
    const results = await db.insert(pendingInvites).values(data).returning();
    return results[0];
  },

  async findPendingInviteByTokenHash(tokenHash: string) {
    const results = await db
      .select({
        id: pendingInvites.id,
        driveId: pendingInvites.driveId,
        email: pendingInvites.email,
        role: pendingInvites.role,
        expiresAt: pendingInvites.expiresAt,
        consumedAt: pendingInvites.consumedAt,
        invitedBy: pendingInvites.invitedBy,
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

  // Atomic single-use: WHERE consumedAt IS NULL inside the UPDATE prevents
  // the read-then-write race that would let two concurrent requests both
  // observe the row as unconsumed and both succeed at acceptance.
  async markInviteConsumed(id: string): Promise<boolean> {
    const updated = await db
      .update(pendingInvites)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(pendingInvites.id, id),
          isNull(pendingInvites.consumedAt)
        )
      )
      .returning({ id: pendingInvites.id });
    return updated.length > 0;
  },

  async deletePendingInvite(id: string): Promise<void> {
    await db.delete(pendingInvites).where(eq(pendingInvites.id, id));
  },

  async findActivePendingInviteByDriveAndEmail(
    driveId: string,
    email: string
  ): Promise<{ id: string } | null> {
    const results = await db
      .select({ id: pendingInvites.id })
      .from(pendingInvites)
      .where(
        and(
          eq(pendingInvites.driveId, driveId),
          eq(pendingInvites.email, email),
          isNull(pendingInvites.consumedAt)
        )
      )
      .limit(1);
    return results.at(0) ?? null;
  },

  async acceptPendingMember(memberId: string): Promise<boolean> {
    const updated = await db
      .update(driveMembers)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(driveMembers.id, memberId),
          isNull(driveMembers.acceptedAt)
        )
      )
      .returning({ id: driveMembers.id });
    return updated.length > 0;
  },
};

export type DriveInviteRepository = typeof driveInviteRepository;
