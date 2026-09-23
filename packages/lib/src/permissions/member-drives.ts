import { db } from '@pagespace/db/db';
import { and, eq, exists, inArray, isNotNull, isNull, ne, or, sql, type SQL } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { orgMembers, type OrgRole } from '@pagespace/db/schema/organizations';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';
import { decideListedDriveRole } from './org-drive-resolution';
import { loadAcceptedRowsInDrives, resolveEffectiveDriveMemberships } from './org-drive-membership';
import type { DriveMemberRole } from './org-access';
import { driveMembershipRole, driveMembershipRow } from './drive-member-role';

/**
 * The drives a person is a member of: the set every "my drives" aggregate (commands, activity,
 * pulse, memory, the app shell, the channel candidate queries) scopes itself to.
 *
 * While ORGS_ENABLED is false it is exactly the union those callers ran inline: owned drives plus
 * ACCEPTED drive_members rows, each with the row's role. While enabled, a drive the person does not
 * own is included when decideListedDriveRole lists it without a page share: a valid row, or an OPEN
 * drive of their org (DRV-5). A stale org row, a former lead's OWNER row, a pending invitation, a
 * page share alone, and org power over a RESTRICTED or PRIVATE drive they have not joined (DRV-6)
 * never make one. Every drive listed is one the person can open, and a cross-drive aggregate over it
 * still filters per page.
 */

export interface MemberDrive {
  driveId: string;
  /** The drive's lead (drives.ownerId). */
  isOwner: boolean;
  /** OWNER for the lead; otherwise the listed role (the row's role while dark). */
  role: DriveMemberRole;
}

export interface MemberDriveOptions {
  /** Include trashed drives. */
  includeTrashed: boolean;
  /** Read inside a caller's transaction (the app shell snapshot). */
  executor?: Pick<typeof db, 'select'>;
}

export async function listMemberDrives(userId: string, options: MemberDriveOptions): Promise<MemberDrive[]> {
  const executor = options.executor ?? db;
  const notTrashed = options.includeTrashed ? undefined : eq(drives.isTrashed, false);

  const owned = await executor
    .select({ id: drives.id })
    .from(drives)
    .where(and(eq(drives.ownerId, userId), notTrashed));

  const rows = await executor
    .select({
      driveId: driveMembers.driveId,
      role: driveMembers.role,
      customRoleId: driveMembers.customRoleId,
      source: driveMembers.source,
      orgId: drives.orgId,
      orgVisibility: drives.orgVisibility,
    })
    .from(driveMembers)
    .innerJoin(drives, eq(drives.id, driveMembers.driveId))
    .where(and(eq(driveMembers.userId, userId), isNotNull(driveMembers.acceptedAt), notTrashed));

  const out = new Map<string, MemberDrive>();
  for (const { id } of owned) out.set(id, { driveId: id, isOwner: true, role: 'OWNER' });

  if (!ORGS_ENABLED) {
    for (const row of rows) {
      const role = driveMembershipRole(row.role);
      if (role !== null && !out.has(row.driveId)) out.set(row.driveId, { driveId: row.driveId, isOwner: false, role });
    }
    return [...out.values()];
  }

  const orgRoles = new Map<string, OrgRole>(
    (await executor
      .select({ orgId: orgMembers.orgId, role: orgMembers.role })
      .from(orgMembers)
      .where(eq(orgMembers.userId, userId))
    ).map((r) => [r.orgId, r.role]),
  );
  const openOrgDrives = orgRoles.size > 0
    ? await executor
      .select({ id: drives.id, orgId: drives.orgId })
      .from(drives)
      .where(and(inArray(drives.orgId, [...orgRoles.keys()]), eq(drives.orgVisibility, 'OPEN'), notTrashed))
    : [];

  const list = (driveId: string, facts: Parameters<typeof decideListedDriveRole>[0]) => {
    if (out.has(driveId)) return;
    const role = decideListedDriveRole(facts);
    if (role !== null) out.set(driveId, { driveId, isOwner: false, role });
  };
  for (const row of rows) {
    list(row.driveId, {
      orgsEnabled: true,
      drive: { orgId: row.orgId, orgVisibility: row.orgVisibility },
      orgRole: row.orgId ? orgRoles.get(row.orgId) ?? null : null,
      row: driveMembershipRow(row),
      viaPagePermission: false,
    });
  }
  for (const drive of openOrgDrives) {
    list(drive.id, {
      orgsEnabled: true,
      drive: { orgId: drive.orgId, orgVisibility: 'OPEN' },
      orgRole: drive.orgId ? orgRoles.get(drive.orgId) ?? null : null,
      row: null,
      viaPagePermission: false,
    });
  }
  return [...out.values()];
}

/**
 * The drives a person may administer: those they lead, plus every drive whose effective membership
 * (resolveEffectiveDriveMemberships) is ADMIN. Unlike listMemberDrives this is not the listing rule:
 * an org Owner or Admin administers every drive of their org, joined or not (ORG-4), so an admin
 * surface (the all-backups list) shows what isDriveOwnerOrAdmin opens. Org power over a PRIVATE drive
 * writes the ORG-4 audit, as every resolver path does. While dark: owned drives plus accepted ADMIN rows.
 */
export async function getAdministeredDriveIds(userId: string, options: { includeTrashed: boolean }): Promise<string[]> {
  const notTrashed = options.includeTrashed ? undefined : eq(drives.isTrashed, false);

  const owned = await db.select({ id: drives.id }).from(drives).where(and(eq(drives.ownerId, userId), notTrashed));
  const ownedIds = new Set(owned.map((d) => d.id));

  const adminRowDrives = await db
    .select({ id: drives.id, orgId: drives.orgId, orgVisibility: drives.orgVisibility })
    .from(driveMembers)
    .innerJoin(drives, eq(drives.id, driveMembers.driveId))
    .where(and(eq(driveMembers.userId, userId), eq(driveMembers.role, 'ADMIN'), isNotNull(driveMembers.acceptedAt), notTrashed));

  const adminOrgIds = ORGS_ENABLED
    ? (await db
      .select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .where(and(eq(orgMembers.userId, userId), inArray(orgMembers.role, ['OWNER', 'ADMIN'])))
    ).map((r) => r.orgId)
    : [];
  const orgDrives = adminOrgIds.length > 0
    ? await db
      .select({ id: drives.id, orgId: drives.orgId, orgVisibility: drives.orgVisibility })
      .from(drives)
      .where(and(inArray(drives.orgId, adminOrgIds), notTrashed))
    : [];

  const candidates = new Map([...adminRowDrives, ...orgDrives].filter((d) => !ownedIds.has(d.id)).map((d) => [d.id, d]));
  if (candidates.size === 0) return [...ownedIds];

  const rows = await loadAcceptedRowsInDrives(db, userId, [...candidates.keys()]);
  const effective = await resolveEffectiveDriveMemberships(
    [...candidates.values()].map((drive) => ({ userId, drive, row: rows.get(drive.id) ?? null })),
    { audit: true },
  );
  const administered = [...candidates.values()].filter((_, i) => effective[i]?.role === 'ADMIN').map((d) => d.id);
  return [...ownedIds, ...administered];
}

export async function getMemberDriveIds(userId: string, options: MemberDriveOptions): Promise<string[]> {
  return (await listMemberDrives(userId, options)).map((d) => d.driveId);
}

/**
 * Whether two people are members of a common drive (both listMemberDrives, trash included). The
 * relationship user lookups rest on: co-membership reveals identity, a page share does not.
 */
export async function sharesMemberDrive(userIdA: string, userIdB: string): Promise<boolean> {
  if (userIdA === userIdB) return false;
  const aDriveIds = new Set(await getMemberDriveIds(userIdA, { includeTrashed: true }));
  if (aDriveIds.size === 0) return false;
  return (await getMemberDriveIds(userIdB, { includeTrashed: true })).some((id) => aDriveIds.has(id));
}

const ONE = { one: sql`1` };

/**
 * listMemberDrives as a SQL condition: true where the user in `userIdColumn` is a member of at least
 * one of `driveIds`, so a search can filter candidates inside the database instead of materializing
 * every co-member. The integration suite checks it against listMemberDrives for every person and
 * drive of the Northwind fixture.
 */
export function memberOfAnyDriveCondition(userIdColumn: SQL.Aliased | Parameters<typeof eq>[0], driveIds: string[]): SQL {
  if (driveIds.length === 0) return sql`false`;

  const owns = exists(
    db.select(ONE).from(drives).where(and(eq(drives.ownerId, userIdColumn), inArray(drives.id, driveIds))),
  );

  if (!ORGS_ENABLED) {
    const acceptedRow = exists(
      db.select(ONE).from(driveMembers).where(and(
        eq(driveMembers.userId, userIdColumn),
        isNotNull(driveMembers.acceptedAt),
        inArray(driveMembers.driveId, driveIds),
      )),
    );
    return or(acceptedRow, owns) as SQL;
  }

  const inDriveOrg = exists(
    db.select(ONE).from(orgMembers).where(and(eq(orgMembers.orgId, drives.orgId), eq(orgMembers.userId, userIdColumn))),
  );
  // validOrgDriveRow in SQL: on an org drive an OWNER row is a former lead's leftover, and an org row
  // counts only for an org member on an OPEN drive. A personal drive's accepted row counts as it is.
  const validRow = exists(
    db.select(ONE).from(driveMembers).innerJoin(drives, eq(drives.id, driveMembers.driveId)).where(and(
      eq(driveMembers.userId, userIdColumn),
      isNotNull(driveMembers.acceptedAt),
      inArray(driveMembers.driveId, driveIds),
      or(
        isNull(drives.orgId),
        and(
          ne(driveMembers.role, 'OWNER'),
          or(ne(driveMembers.source, 'org'), and(eq(drives.orgVisibility, 'OPEN'), inDriveOrg)),
        ),
      ),
    )),
  );
  const implicitOpen = exists(
    db.select(ONE).from(drives).innerJoin(orgMembers, eq(orgMembers.orgId, drives.orgId)).where(and(
      inArray(drives.id, driveIds),
      eq(drives.orgVisibility, 'OPEN'),
      eq(orgMembers.userId, userIdColumn),
    )),
  );
  return or(owns, validRow, implicitOpen) as SQL;
}
