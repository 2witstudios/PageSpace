/**
 * Drive Member Service - Core business logic for drive member operations
 *
 * This service encapsulates all drive member-related database operations,
 * providing a clean seam for testing route handlers.
 */

import {
  db,
  eq,
  and,
  sql,
  driveMembers,
  drives,
  users,
  userProfiles,
  driveRoles,
  pagePermissions,
  pages,
} from '@pagespace/db';

// ============================================================================
// Types
// ============================================================================

export interface MemberWithDetails {
  id: string;
  userId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  invitedBy: string | null;
  invitedAt: Date | null;
  acceptedAt: Date | null;
  lastAccessedAt: Date | null;
  user: {
    id: string;
    email: string;
    name: string | null;
  } | null;
  profile: {
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  } | null;
  customRole: {
    id: string;
    name: string;
    color: string | null;
  } | null;
  permissionCounts?: {
    view: number;
    edit: number;
    share: number;
  };
}

export interface DriveAccessResult {
  isOwner: boolean;
  isAdmin: boolean;
  isMember: boolean;
  drive: typeof drives.$inferSelect | null;
}

export interface AddMemberInput {
  userId: string;
  role?: 'ADMIN' | 'MEMBER';
}

export interface MemberPermission {
  pageId: string;
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Check if user has access to drive and get their role
 */
export async function checkDriveAccess(
  driveId: string,
  userId: string
): Promise<DriveAccessResult> {
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
  });

  if (!drive) {
    return { isOwner: false, isAdmin: false, isMember: false, drive: null };
  }

  const isOwner = drive.ownerId === userId;

  if (isOwner) {
    return { isOwner: true, isAdmin: true, isMember: true, drive };
  }

  const membership = await db
    .select({ role: driveMembers.role })
    .from(driveMembers)
    .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId)))
    .limit(1);

  if (membership.length === 0) {
    return { isOwner: false, isAdmin: false, isMember: false, drive };
  }

  const role = membership[0].role;
  return {
    isOwner: false,
    isAdmin: role === 'ADMIN',
    isMember: true,
    drive,
  };
}

/**
 * Get all user IDs that are members of a drive
 * Efficient query for authorization checks
 */
export async function getDriveMemberUserIds(driveId: string): Promise<string[]> {
  const members = await db
    .select({ userId: driveMembers.userId })
    .from(driveMembers)
    .where(eq(driveMembers.driveId, driveId));

  return members.map((m) => m.userId);
}

/**
 * List all members of a drive with their details and permission counts
 */
export async function listDriveMembers(driveId: string): Promise<MemberWithDetails[]> {
  const members = await db
    .select({
      id: driveMembers.id,
      userId: driveMembers.userId,
      role: driveMembers.role,
      invitedBy: driveMembers.invitedBy,
      invitedAt: driveMembers.invitedAt,
      acceptedAt: driveMembers.acceptedAt,
      lastAccessedAt: driveMembers.lastAccessedAt,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
      },
      profile: {
        username: userProfiles.username,
        displayName: userProfiles.displayName,
        avatarUrl: userProfiles.avatarUrl,
      },
      customRole: {
        id: driveRoles.id,
        name: driveRoles.name,
        color: driveRoles.color,
      },
    })
    .from(driveMembers)
    .leftJoin(users, eq(driveMembers.userId, users.id))
    .leftJoin(userProfiles, eq(driveMembers.userId, userProfiles.userId))
    .leftJoin(driveRoles, eq(driveMembers.customRoleId, driveRoles.id))
    .where(eq(driveMembers.driveId, driveId));

  // Get permission counts for each member
  const memberData = await Promise.all(
    members.map(async (member) => {
      const { rows: permCounts } = await db.execute(sql`
        SELECT 
          COUNT(CASE WHEN pp."canView" = true THEN 1 END) as view_count,
          COUNT(CASE WHEN pp."canEdit" = true THEN 1 END) as edit_count,
          COUNT(CASE WHEN pp."canShare" = true THEN 1 END) as share_count
        FROM page_permissions pp
        JOIN pages p ON pp."pageId" = p.id
        WHERE pp."userId" = ${member.userId} AND p."driveId" = ${driveId}
      `);

      return {
        ...member,
        role: member.role as 'OWNER' | 'ADMIN' | 'MEMBER',
        permissionCounts: {
          view: Number(permCounts[0]?.view_count || 0),
          edit: Number(permCounts[0]?.edit_count || 0),
          share: Number(permCounts[0]?.share_count || 0),
        },
      };
    })
  );

  return memberData;
}

/**
 * Check if a user is already a member of a drive
 */
export async function isMemberOfDrive(driveId: string, userId: string): Promise<boolean> {
  const existing = await db
    .select({ id: driveMembers.id })
    .from(driveMembers)
    .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId)))
    .limit(1);

  return existing.length > 0;
}

/**
 * Add a new member to a drive
 */
export async function addDriveMember(
  driveId: string,
  invitedBy: string,
  input: AddMemberInput
): Promise<typeof driveMembers.$inferSelect> {
  const [newMember] = await db
    .insert(driveMembers)
    .values({
      driveId,
      userId: input.userId,
      role: input.role || 'MEMBER',
      invitedBy,
      acceptedAt: new Date(), // Auto-accept for now
    })
    .returning();

  return newMember;
}

/**
 * Get a specific member's details with their permissions
 */
export async function getDriveMemberDetails(
  driveId: string,
  targetUserId: string
): Promise<MemberWithDetails | null> {
  const memberData = await db
    .select({
      id: driveMembers.id,
      userId: driveMembers.userId,
      role: driveMembers.role,
      customRoleId: driveMembers.customRoleId,
      invitedBy: driveMembers.invitedBy,
      invitedAt: driveMembers.invitedAt,
      acceptedAt: driveMembers.acceptedAt,
      lastAccessedAt: driveMembers.lastAccessedAt,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
      },
      profile: {
        username: userProfiles.username,
        displayName: userProfiles.displayName,
        avatarUrl: userProfiles.avatarUrl,
      },
    })
    .from(driveMembers)
    .leftJoin(users, eq(driveMembers.userId, users.id))
    .leftJoin(userProfiles, eq(driveMembers.userId, userProfiles.userId))
    .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, targetUserId)))
    .limit(1);

  if (memberData.length === 0) {
    return null;
  }

  return {
    ...memberData[0],
    role: memberData[0].role as 'OWNER' | 'ADMIN' | 'MEMBER',
    customRole: null, // Would need to join separately if customRoleId exists
  };
}

/**
 * Get permissions for a member in a drive
 */
export async function getMemberPermissions(
  driveId: string,
  targetUserId: string
): Promise<MemberPermission[]> {
  const permissions = await db
    .select({
      pageId: pagePermissions.pageId,
      canView: pagePermissions.canView,
      canEdit: pagePermissions.canEdit,
      canShare: pagePermissions.canShare,
    })
    .from(pagePermissions)
    .innerJoin(pages, eq(pagePermissions.pageId, pages.id))
    .where(and(eq(pagePermissions.userId, targetUserId), eq(pages.driveId, driveId)));

  return permissions;
}

/**
 * Update a member's role
 */
export async function updateMemberRole(
  driveId: string,
  targetUserId: string,
  role: 'ADMIN' | 'MEMBER',
  customRoleId?: string | null
): Promise<{ oldRole: string }> {
  const [existing] = await db
    .select({ role: driveMembers.role })
    .from(driveMembers)
    .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, targetUserId)))
    .limit(1);

  const oldRole = existing?.role || 'MEMBER';

  const updateData: { role?: 'OWNER' | 'ADMIN' | 'MEMBER'; customRoleId?: string | null } = {};
  if (role) {
    updateData.role = role;
  }
  if (customRoleId !== undefined) {
    updateData.customRoleId = customRoleId || null;
  }

  if (Object.keys(updateData).length > 0) {
    await db
      .update(driveMembers)
      .set(updateData)
      .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, targetUserId)));
  }

  return { oldRole };
}

/**
 * Update member's page permissions (replaces all existing permissions)
 */
export async function updateMemberPermissions(
  driveId: string,
  targetUserId: string,
  grantedBy: string,
  permissions: MemberPermission[]
): Promise<number> {
  // Get all pages in the drive to validate pageIds
  const drivePages = await db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, driveId));

  const validPageIds = new Set(drivePages.map((p) => p.id));

  // Get existing permissions for this user in this drive
  const existingPermissions = await db
    .select({ pageId: pagePermissions.pageId })
    .from(pagePermissions)
    .innerJoin(pages, eq(pagePermissions.pageId, pages.id))
    .where(and(eq(pagePermissions.userId, targetUserId), eq(pages.driveId, driveId)));

  // Delete existing permissions
  for (const perm of existingPermissions) {
    await db
      .delete(pagePermissions)
      .where(and(eq(pagePermissions.userId, targetUserId), eq(pagePermissions.pageId, perm.pageId)));
  }

  // Insert new permissions
  const newPermissions = permissions
    .filter((p) => validPageIds.has(p.pageId))
    .filter((p) => p.canView || p.canEdit || p.canShare)
    .map((p) => ({
      pageId: p.pageId,
      userId: targetUserId,
      canView: p.canView || false,
      canEdit: p.canEdit || false,
      canShare: p.canShare || false,
      grantedBy,
      grantedAt: new Date(),
    }));

  if (newPermissions.length > 0) {
    await db.insert(pagePermissions).values(newPermissions);
  }

  return newPermissions.length;
}
