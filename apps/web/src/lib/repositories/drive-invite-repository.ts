/**
 * Repository for drive member invitation database operations.
 * This seam isolates query-builder details from the invite route handler,
 * enabling proper unit testing without ORM chain mocking.
 */

import {
  db,
  drives,
  driveMembers,
  pages,
  pagePermissions,
  users,
  eq,
  and,
} from '@pagespace/db';

export const driveInviteRepository = {
  async findDriveById(driveId: string) {
    const results = await db
      .select()
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);
    return results[0] ?? null;
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
    return results[0] ?? null;
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
    return results[0] ?? null;
  },

  async createDriveMember(data: {
    driveId: string;
    userId: string;
    role: string;
    customRoleId: string | null;
    invitedBy: string;
    acceptedAt: Date;
  }) {
    const results = await db
      .insert(driveMembers)
      .values(data)
      .returning();
    return results[0];
  },

  async updateDriveMemberRole(
    memberId: string,
    role: string,
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
    return results[0] ?? null;
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
};

export type DriveInviteRepository = typeof driveInviteRepository;
