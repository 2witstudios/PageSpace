/**
 * Drive Member Service - Core business logic for drive member operations
 *
 * This service encapsulates all drive member-related database operations,
 * providing a clean seam for testing route handlers.
 */

import { db } from '@pagespace/db/db';
import { eq, and, sql, isNotNull } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers, userProfiles, driveRoles, pagePermissions } from '@pagespace/db/schema/members';
import { decryptUserRow, decryptUsersByIdOnce } from '../auth/user-repository';
import { loadEffectiveDriveMembership } from '../permissions/org-drive-membership';
import { isDriveLead } from '../permissions/drive-relationship';
import { listDriveAudience } from '../permissions/drive-audience';
import { isGuestRole } from '../permissions/guest-role';

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

  const isOwner = isDriveLead(userId, drive);

  if (isOwner) {
    return { isOwner: true, isAdmin: true, isMember: true, drive };
  }

  // The shared org-aware membership: accepted rows only, org Owner/Admin power, implicit Open
  // membership, and stale org or former-lead OWNER rows counting for nothing.
  const membership = await loadEffectiveDriveMembership(userId, drive);

  if (!membership) {
    return { isOwner: false, isAdmin: false, isMember: false, drive };
  }

  return {
    isOwner: false,
    isAdmin: membership.role === 'ADMIN',
    isMember: true,
    drive,
  };
}

/**
 * Get all user IDs that are members of a drive: the drive's lead and everyone the org-aware
 * membership admits (listDriveAudience). Pending invitations and stale org rows are no members.
 */
export async function getDriveMemberUserIds(driveId: string): Promise<string[]> {
  return (await listDriveAudience(driveId)).map((m) => m.userId);
}

/**
 * Get all user IDs who should receive broadcast events for a drive: the lead plus every
 * effective member (org Owner/Admins and implicit Open members included, stale org rows and
 * pending invitations excluded).
 */
export async function getDriveRecipientUserIds(driveId: string): Promise<string[]> {
  return (await listDriveAudience(driveId)).map((m) => m.userId);
}

/**
 * Get user IDs of drive members with a specific standard role (the effective role: an org
 * Owner/Admin is ADMIN). OWNER is the drive's lead (drives.ownerId).
 */
export async function getDriveMemberUserIdsByStandardRole(
  driveId: string,
  role: 'OWNER' | 'ADMIN' | 'MEMBER',
): Promise<string[]> {
  return (await listDriveAudience(driveId))
    .filter((m) => (role === 'OWNER' ? m.isOwner : !m.isOwner && m.role === role))
    .map((m) => m.userId);
}

/**
 * Get user IDs of drive members assigned a specific custom role (an implicit Open member holds
 * the drive's default role).
 */
export async function getDriveMemberUserIdsByCustomRole(
  driveId: string,
  customRoleId: string,
): Promise<string[]> {
  return (await listDriveAudience(driveId))
    .filter((m) => !m.isOwner && m.customRoleId === customRoleId)
    .map((m) => m.userId);
}

/**
 * List all members of a drive with their details and permission counts
 */
export async function listDriveMembers(driveId: string): Promise<MemberWithDetails[]> {
  const rows = await db
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

  // A GUEST is not a member of the drive: it is listed where its page grants
  // are (the page's share dialog), not on the Members page or in member counts.
  const members = rows.filter((m) => !isGuestRole(m.role));

  if (members.length === 0) return [];

  const memberUserIds = members.map((m) => m.userId);
  const idList = sql.join(memberUserIds.map((id) => sql`${id}`), sql`, `);

  const { rows: permCountRows } = await db.execute(sql`
    SELECT pp."userId",
      COUNT(CASE WHEN pp."canView" THEN 1 END) as view_count,
      COUNT(CASE WHEN pp."canEdit" THEN 1 END) as edit_count,
      COUNT(CASE WHEN pp."canShare" THEN 1 END) as share_count
    FROM page_permissions pp
    JOIN pages p ON pp."pageId" = p.id
    WHERE p."driveId" = ${driveId}
      AND pp."userId" IN (${idList})
    GROUP BY pp."userId"
  `);

  const permMap = new Map(
    (permCountRows as Array<Record<string, unknown>>).map((row) => [
      row.userId as string,
      {
        view: Number(row.view_count || 0),
        edit: Number(row.edit_count || 0),
        share: Number(row.share_count || 0),
      },
    ])
  );

  // Decrypt each unique joined user once (legacy plaintext passes through),
  // even if the same user is ever joined in on more than one row.
  const decryptedUsersById = await decryptUsersByIdOnce(members.map((member) => member.user));

  return members.map((member) => ({
    ...member,
    user: member.user ? decryptedUsersById.get(member.user.id) ?? member.user : member.user,
    role: member.role as 'OWNER' | 'ADMIN' | 'MEMBER',
    permissionCounts: permMap.get(member.userId) ?? { view: 0, edit: 0, share: 0 },
  }));
}

/**
 * Build a MemberWithDetails-shaped entry for the drive owner. The owner is
 * never a row in drive_members (ownership lives on drives.ownerId), so
 * listDriveMembers alone omits them — callers that need a complete roster
 * (e.g. the members list API) must prepend this. Returns null only if the
 * drive itself doesn't exist.
 */
export async function getDriveOwnerAsMember(driveId: string): Promise<MemberWithDetails | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      username: userProfiles.username,
      displayName: userProfiles.displayName,
      avatarUrl: userProfiles.avatarUrl,
    })
    .from(drives)
    .innerJoin(users, eq(drives.ownerId, users.id))
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(eq(drives.id, driveId))
    .limit(1);

  if (!row) return null;

  return {
    id: `owner-${row.id}`,
    userId: row.id,
    role: 'OWNER',
    invitedBy: null,
    invitedAt: null,
    acceptedAt: null,
    lastAccessedAt: null,
    user: await decryptUserRow({ id: row.id, email: row.email, name: row.name }),
    profile: { username: row.username, displayName: row.displayName, avatarUrl: row.avatarUrl },
    customRole: null,
    permissionCounts: { view: 0, edit: 0, share: 0 },
  };
}

/**
 * Check if a user is a member of a drive: its lead or an effective member (listDriveAudience).
 */
export async function isMemberOfDrive(driveId: string, userId: string): Promise<boolean> {
  return (await listDriveAudience(driveId)).some((m) => m.userId === userId);
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

  // A GUEST is not a drive member, so it has no member detail page.
  if (memberData.length === 0 || isGuestRole(memberData[0].role)) {
    return null;
  }

  return {
    ...memberData[0],
    // Decrypt the joined user's PII at the edge (legacy plaintext passes through).
    user: await decryptUserRow(memberData[0].user),
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
): Promise<{ oldRole: string; oldCustomRoleId: string | null }> {
  const [existing] = await db
    .select({ role: driveMembers.role, customRoleId: driveMembers.customRoleId })
    .from(driveMembers)
    .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, targetUserId)))
    .limit(1);

  const oldRole = existing?.role || 'MEMBER';
  const oldCustomRoleId = existing?.customRoleId ?? null;

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

  return { oldRole, oldCustomRoleId };
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
