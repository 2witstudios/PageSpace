/**
 * Repository for drive member invitation database operations.
 * This seam isolates query-builder details from the invite route handler,
 * enabling proper unit testing without ORM chain mocking.
 */

import { db } from '@pagespace/db/db'
import { eq, and, isNull } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { drives, pages } from '@pagespace/db/schema/core'
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';

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
    const results = await db
      .select()
      .from(driveMembers)
      .where(
        and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, userId),
          eq(driveMembers.role, 'ADMIN')
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

  async findUserIdByEmail(email: string) {
    const normalized = email.toLowerCase().trim();
    const result = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalized))
      .limit(1);
    return result.at(0) ?? null;
  },

  async findActivePendingMemberByEmail(driveId: string, email: string) {
    const normalized = email.toLowerCase().trim();
    const result = await db
      .select({ id: driveMembers.id })
      .from(driveMembers)
      .innerJoin(users, eq(users.id, driveMembers.userId))
      .where(
        and(
          eq(driveMembers.driveId, driveId),
          eq(users.email, normalized),
          isNull(driveMembers.acceptedAt)
        )
      )
      .limit(1);
    return result.at(0) ?? null;
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

  async findInviterDisplay(userId: string): Promise<{ name: string; email: string } | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, email: true },
    });
    if (!user) return null;
    return { name: user.name || user.email, email: user.email };
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

  async bumpInvitedAt(memberId: string): Promise<void> {
    await db
      .update(driveMembers)
      .set({ invitedAt: new Date() })
      .where(eq(driveMembers.id, memberId));
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
