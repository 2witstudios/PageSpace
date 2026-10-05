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

/**
 * POL-2 for a restore (independent review of #2762, P1-3): may this person's restored access go back in? Asked once
 * per person with everything the backup would give them on the drive. `admit` writes it; `refused` (the org has
 * guests off) skips it and reports it; `held` (approve) queued it for an Owner or Admin and writes nothing.
 */
export type RestoreAdmission = (input: {
  userId: string;
  member: Record<string, unknown> | null;
  grants: BackupPerm[];
}) => Promise<'admit' | 'refused' | 'held'>;

export const admitEveryone: RestoreAdmission = async () => 'admit';

export async function applyPermRestoreOps(
  permOps: PermOps,
  memberOps: MemberOps,
  roleOps: RoleOps,
  driveId: string,
  tx: DbLike,
  admit: RestoreAdmission = admitEveryone,
): Promise<{ skippedMembers: string[]; skippedPermissions: string[]; refusedByGuestPolicy: string[]; queuedForApproval: string[] }> {
  const skippedMembers: string[] = [];
  const skippedPermissions: string[] = [];
  const refusedByGuestPolicy: string[] = [];
  const queuedForApproval: string[] = [];

  // 1. Delete current page permissions for affected pages
  for (const del of permOps.toDelete) {
    await tx.delete(pagePermissions).where(
      and(eq(pagePermissions.pageId, del.pageId), eq(pagePermissions.userId, del.userId)),
    );
  }

  // 2. Delete current drive members (releases FK dep on driveRoles.customRoleId). Before the admission questions
  //    below, so a member row the restore removes is not taken as the person's standing on the drive.
  if (memberOps.toDelete.length > 0) {
    await tx.delete(driveMembers).where(
      and(eq(driveMembers.driveId, driveId), inArray(driveMembers.userId, memberOps.toDelete)),
    );
  }

  // 3. Ask the org's guests policy once per person the restore would put back (skip anyone whose account is gone).
  const membersByUser = new Map(memberOps.toInsert.map((m) => [m.userId, m]));
  const grantsByUser = new Map<string, BackupPerm[]>();
  for (const perm of permOps.toInsert) grantsByUser.set(perm.userId, [...(grantsByUser.get(perm.userId) ?? []), perm]);
  const admitted = new Set<string>();
  for (const userId of new Set([...membersByUser.keys(), ...grantsByUser.keys()])) {
    const existing = await tx.select().from(users).where(eq(users.id, userId));
    if (!existing || existing.length === 0) {
      if (membersByUser.has(userId)) skippedMembers.push(userId);
      for (let i = 0; i < (grantsByUser.get(userId)?.length ?? 0); i += 1) skippedPermissions.push(userId);
      continue;
    }
    const decision = await admit({ userId, member: membersByUser.get(userId) ?? null, grants: grantsByUser.get(userId) ?? [] });
    if (decision === 'admit') admitted.add(userId);
    else if (decision === 'refused') refusedByGuestPolicy.push(userId);
    else queuedForApproval.push(userId);
  }

  // 4. Insert backup permissions of the admitted
  for (const perm of permOps.toInsert) {
    if (admitted.has(perm.userId)) await tx.insert(pagePermissions).values(perm);
  }

  // 5. Delete current drive roles — done before inserting backup members so that
  //    members with a customRoleId referencing restored roles can be inserted safely.
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

  // 7. Insert backup members of the admitted — roles are present now, so customRoleId FKs resolve
  for (const member of memberOps.toInsert) {
    if (admitted.has(member.userId)) await tx.insert(driveMembers).values({ driveId, ...member });
  }

  return { skippedMembers, skippedPermissions, refusedByGuestPolicy, queuedForApproval };
}
