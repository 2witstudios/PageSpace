import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNotNull } from '@pagespace/db/operators';
import { drives, type OrgDriveVisibility } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles } from '@pagespace/db/schema/members';
import { orgMembers, type OrgRole } from '@pagespace/db/schema/organizations';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';
import { decideDriveAudience, type DriveAudienceMember, type DriveAudienceRow } from './org-drive-resolution';
import { driveMembershipRow } from './drive-member-role';


/** Chunk size for id IN lists (Postgres bind parameter limit). */
const IN_LIST_CHUNK = 500;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_LIST_CHUNK) out.push(items.slice(i, i + IN_LIST_CHUNK));
  return out;
}

/**
 * The members of each drive (decideDriveAudience), keyed by drive id; a missing drive has no entry.
 * Constant queries however many drives: the drives, their accepted rows, and (only while
 * ORGS_ENABLED, only for org drives) the orgs' members and the OPEN drives' default roles. Writes no
 * ORG-4 audit event: an audience is computed, nobody accessed anything.
 */
export async function listDriveAudiences(driveIds: string[]): Promise<Map<string, DriveAudienceMember[]>> {
  const ids = [...new Set(driveIds)];
  const audiences = new Map<string, DriveAudienceMember[]>();
  if (ids.length === 0) return audiences;

  const driveRows: Array<{ id: string; ownerId: string; orgId: string | null; orgVisibility: OrgDriveVisibility }> = [];
  const rowsByDrive = new Map<string, DriveAudienceRow[]>();
  for (const chunk of chunks(ids)) {
    driveRows.push(...await db
      .select({ id: drives.id, ownerId: drives.ownerId, orgId: drives.orgId, orgVisibility: drives.orgVisibility })
      .from(drives)
      .where(inArray(drives.id, chunk)));
    const rows = await db
      .select({ driveId: driveMembers.driveId, userId: driveMembers.userId, role: driveMembers.role, customRoleId: driveMembers.customRoleId, source: driveMembers.source })
      .from(driveMembers)
      .where(and(inArray(driveMembers.driveId, chunk), isNotNull(driveMembers.acceptedAt)));
    for (const row of rows) {
      // A GUEST row (a redeemed page share link) is no membership: never in the drive's audience.
      const membership = driveMembershipRow(row);
      if (membership === null) continue;
      const list = rowsByDrive.get(row.driveId) ?? [];
      list.push({ userId: row.userId, ...membership });
      rowsByDrive.set(row.driveId, list);
    }
  }

  const orgDrives = ORGS_ENABLED ? driveRows.filter((d) => d.orgId !== null) : [];
  const orgRolesByOrg = new Map<string, Map<string, OrgRole>>();
  const defaultRoleByDrive = new Map<string, string>();
  if (orgDrives.length > 0) {
    for (const orgIds of chunks([...new Set(orgDrives.map((d) => d.orgId as string))])) {
      const members = await db
        .select({ orgId: orgMembers.orgId, userId: orgMembers.userId, role: orgMembers.role })
        .from(orgMembers)
        .where(inArray(orgMembers.orgId, orgIds));
      for (const m of members) {
        const roles = orgRolesByOrg.get(m.orgId) ?? new Map<string, OrgRole>();
        roles.set(m.userId, m.role);
        orgRolesByOrg.set(m.orgId, roles);
      }
    }
    const openIds = orgDrives.filter((d) => d.orgVisibility === 'OPEN').map((d) => d.id);
    for (const chunk of chunks(openIds)) {
      const defaults = await db
        .select({ driveId: driveRoles.driveId, id: driveRoles.id })
        .from(driveRoles)
        .where(and(inArray(driveRoles.driveId, chunk), eq(driveRoles.isDefault, true)));
      for (const d of defaults) if (!defaultRoleByDrive.has(d.driveId)) defaultRoleByDrive.set(d.driveId, d.id);
    }
  }

  for (const drive of driveRows) {
    audiences.set(drive.id, decideDriveAudience({
      orgsEnabled: ORGS_ENABLED,
      drive,
      rows: rowsByDrive.get(drive.id) ?? [],
      orgRoles: drive.orgId ? orgRolesByOrg.get(drive.orgId) ?? new Map() : new Map(),
      driveDefaultRole: { role: 'MEMBER', customRoleId: defaultRoleByDrive.get(drive.id) ?? null },
    }));
  }
  return audiences;
}

export async function listDriveAudience(driveId: string): Promise<DriveAudienceMember[]> {
  return (await listDriveAudiences([driveId])).get(driveId) ?? [];
}
