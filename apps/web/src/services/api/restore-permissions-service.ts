import { eq, and, inArray } from '@pagespace/db/operators';
import { pagePermissions, driveMembers, driveRoles } from '@pagespace/db/schema/members';
import { users } from '@pagespace/db/schema/auth';

type BackupPerm = {
  pageId: string;
  userId: string;
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
  [key: string]: unknown;
};

type CurrentPerm = { pageId: string; userId: string };
type BackupMember = { userId: string; [key: string]: unknown };
type CurrentMember = { userId: string };
type BackupRole = { roleId: string; [key: string]: unknown };
type CurrentRole = { roleId: string };

export function planPermissionRestoreOps(
  backupPerms: BackupPerm[],
  currentPerms: CurrentPerm[],
  affectedPageIds: string[],
): { toDelete: { pageId: string; userId: string }[]; toInsert: BackupPerm[] } {
  const affectedSet = new Set(affectedPageIds);

  const toDelete = currentPerms.filter(p => affectedSet.has(p.pageId)).map(p => ({
    pageId: p.pageId,
    userId: p.userId,
  }));

  const toInsert = backupPerms.filter(p => affectedSet.has(p.pageId));

  return { toDelete, toInsert };
}

export function planMemberRestoreOps(
  backupMembers: BackupMember[],
  currentMembers: CurrentMember[],
): { toDelete: string[]; toInsert: BackupMember[] } {
  return {
    toDelete: currentMembers.map(m => m.userId),
    toInsert: backupMembers,
  };
}

export function planRoleRestoreOps(
  backupRoles: BackupRole[],
  currentRoles: CurrentRole[],
): { toDelete: string[]; toInsert: BackupRole[] } {
  return {
    toDelete: currentRoles.map(r => r.roleId),
    toInsert: backupRoles,
  };
}

type PermOps = ReturnType<typeof planPermissionRestoreOps>;
type MemberOps = ReturnType<typeof planMemberRestoreOps>;
type RoleOps = ReturnType<typeof planRoleRestoreOps>;

type DbLike = {
  delete: (table: unknown) => { where: (cond: unknown) => Promise<unknown> };
  insert: (table: unknown) => { values: (values: unknown) => Promise<unknown> };
  select: () => { from: (table: unknown) => { where: (cond: unknown) => Promise<{ id: string }[]> } };
};

export async function applyPermRestoreOps(
  permOps: PermOps,
  memberOps: MemberOps,
  roleOps: RoleOps,
  driveId: string,
  tx: DbLike,
): Promise<{ skippedMembers: string[]; skippedPermissions: string[] }> {
  const skippedMembers: string[] = [];
  const skippedPermissions: string[] = [];

  // 1. Delete current page permissions for affected pages
  for (const del of permOps.toDelete) {
    await tx.delete(pagePermissions).where(
      and(eq(pagePermissions.pageId, del.pageId), eq(pagePermissions.userId, del.userId)),
    );
  }

  // 2. Insert backup permissions (skip if user no longer exists)
  for (const perm of permOps.toInsert) {
    const existing = await tx.select().from(users).where(eq(users.id, perm.userId));
    if (!existing || existing.length === 0) {
      skippedPermissions.push(perm.userId);
      continue;
    }
    await tx.insert(pagePermissions).values(perm);
  }

  // 3. Delete current drive members
  if (memberOps.toDelete.length > 0) {
    await tx.delete(driveMembers).where(
      and(eq(driveMembers.driveId, driveId), inArray(driveMembers.userId, memberOps.toDelete)),
    );
  }

  // 4. Insert backup members (skip if user no longer exists)
  for (const member of memberOps.toInsert) {
    const existing = await tx.select().from(users).where(eq(users.id, member.userId));
    if (!existing || existing.length === 0) {
      skippedMembers.push(member.userId);
      continue;
    }
    await tx.insert(driveMembers).values({ driveId, ...member });
  }

  // 5. Delete current drive roles
  if (roleOps.toDelete.length > 0) {
    await tx.delete(driveRoles).where(
      and(eq(driveRoles.driveId, driveId), inArray(driveRoles.id, roleOps.toDelete)),
    );
  }

  // 6. Insert backup roles — map roleId → id to match the live driveRoles schema
  for (const role of roleOps.toInsert) {
    const { roleId, ...rest } = role as { roleId: string; [key: string]: unknown };
    await tx.insert(driveRoles).values({ id: roleId, driveId, ...rest });
  }

  return { skippedMembers, skippedPermissions };
}
