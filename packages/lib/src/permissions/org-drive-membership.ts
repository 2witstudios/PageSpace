import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNotNull } from '@pagespace/db/operators';
import type { OrgDriveVisibility } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles } from '@pagespace/db/schema/members';
import { orgMembers, type OrgRole } from '@pagespace/db/schema/organizations';
import { auditOrgAdminPrivateDriveAccess } from './org-admin-access-audit';
import { ORGS_ENABLED } from '../organizations/orgs-enabled';
import type { DriveMemberRole, DriveRoleGrant, OrgDriveMembership } from './org-access';
import { drives } from '@pagespace/db/schema/core';
import {
  explicitScopeAuthorityRow,
  resolveEffectiveDriveMembership,
  validOrgDriveRow,
  type EffectiveDriveMembership,
  type ExplicitScopeAuthority,
} from './org-drive-resolution';

/**
 * The IO around resolveEffectiveDriveMembership for ONE human and ONE drive they do not own:
 * the accepted drive_members row, then (only while ORGS_ENABLED, only for an org drive) the
 * user's org role and the drive's default role, then the ORG-4 audit event when org Owner/Admin
 * power opened a PRIVATE drive.
 *
 * While dark it runs exactly the one membership query the resolvers ran before orgs existed.
 */

export interface MembershipDrive {
  id: string;
  /** Undefined is read as a personal drive. */
  orgId?: string | null;
  orgVisibility?: OrgDriveVisibility | null;
}

const NO_DEFAULT_ROLE: DriveRoleGrant = { role: 'MEMBER', customRoleId: null };

export async function loadEffectiveDriveMembership(
  userId: string,
  drive: MembershipDrive,
): Promise<EffectiveDriveMembership | null> {
  const rows = await db
    .select({ role: driveMembers.role, customRoleId: driveMembers.customRoleId, source: driveMembers.source })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.driveId, drive.id),
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt),
    ))
    .limit(1);

  const [effective] = await resolveEffectiveDriveMemberships(
    [{ userId, drive, row: toMembership(rows[0]) }],
    { audit: true },
  );
  return effective;
}

export interface MembershipCandidate {
  userId: string;
  drive: MembershipDrive;
  /** The user's ACCEPTED drive_members row for this drive, already read by the caller. */
  row: OrgDriveMembership | null;
}

export interface ResolveMembershipsOptions {
  /**
   * Write the ORG-4 event when org power opens a PRIVATE drive. True when the answer serves the
   * user's own request (opening, listing pages, searching, a realtime join or event). False when it
   * computes an audience (which OTHER users can see a page): nobody accessed anything.
   */
  audit: boolean;
}

/**
 * The effective membership of many (user, drive) pairs whose accepted rows the caller already read,
 * in the order given. The ONE IO edge every human drive resolver goes through, single or batched:
 * while ORGS_ENABLED is false, or for a personal drive, it runs no query and returns the row.
 * Otherwise it reads the org roles (one query) and the default roles of the OPEN drives a row-less
 * member needs (one query), then applies resolveEffectiveDriveMembership to each pair.
 */
export async function resolveEffectiveDriveMemberships(
  candidates: MembershipCandidate[],
  options: ResolveMembershipsOptions,
): Promise<Array<EffectiveDriveMembership | null>> {
  const facts = candidates.map(({ drive }) => ({
    orgId: drive.orgId ?? null,
    orgVisibility: drive.orgVisibility ?? 'OPEN',
  }));

  if (!ORGS_ENABLED || facts.every((f) => f.orgId === null)) {
    return candidates.map(({ row }, i) => resolveEffectiveDriveMembership({
      orgsEnabled: false,
      drive: facts[i],
      orgRole: null,
      row,
      driveDefaultRole: NO_DEFAULT_ROLE,
    }));
  }

  const orgRoles = await findOrgRoles(candidates.flatMap(({ userId }, i) => {
    const orgId = facts[i].orgId;
    return orgId === null ? [] : [{ orgId, userId }];
  }));
  const orgRoleOf = (i: number): OrgRole | null => {
    const orgId = facts[i].orgId;
    return orgId === null ? null : orgRoles.get(orgRoleKey(orgId, candidates[i].userId)) ?? null;
  };

  // A stale row (a misplaced org row, a former lead's OWNER row) counts as no row here too, or the
  // member would resolve the implicit OPEN membership without the drive's default role.
  const needsDefaultRole = candidates.map(({ row }, i) => {
    const orgRole = orgRoleOf(i);
    return facts[i].orgId !== null
      && orgRole === 'MEMBER'
      && facts[i].orgVisibility === 'OPEN'
      && validOrgDriveRow(row, facts[i], orgRole) === null;
  });
  const defaultRoles = await findDefaultCustomRoleIds(
    candidates.filter((_, i) => needsDefaultRole[i]).map(({ drive }) => drive.id),
  );

  return candidates.map(({ userId, drive, row }, i) => {
    const orgId = facts[i].orgId;
    if (orgId === null) {
      return resolveEffectiveDriveMembership({
        orgsEnabled: false, drive: facts[i], orgRole: null, row, driveDefaultRole: NO_DEFAULT_ROLE,
      });
    }
    const orgRole = orgRoleOf(i);
    const effective = resolveEffectiveDriveMembership({
      orgsEnabled: true,
      drive: facts[i],
      orgRole,
      row,
      driveDefaultRole: needsDefaultRole[i]
        ? { role: 'MEMBER', customRoleId: defaultRoles.get(drive.id) ?? null }
        : NO_DEFAULT_ROLE,
    });
    if (options.audit && effective?.auditOrgAdminPrivateAccess && orgRole !== null) {
      void auditOrgAdminPrivateDriveAccess({ userId, driveId: drive.id, orgId, orgRole });
    }
    return effective;
  });
}

function toMembership(
  found: { role: string; customRoleId: string | null; source: OrgDriveMembership['source'] } | undefined,
): OrgDriveMembership | null {
  return found
    ? { role: found.role as DriveMemberRole, customRoleId: found.customRoleId ?? null, source: found.source }
    : null;
}

/**
 * The membership that may back an explicit-role token scope on a drive the user does not own
 * (explicitScopeAuthorityRow). Reads nothing while ORGS_ENABLED is false.
 */
export async function loadExplicitScopeAuthority(userId: string, driveId: string): Promise<ExplicitScopeAuthority> {
  if (!ORGS_ENABLED) return { orgDrive: false };

  const [drive] = await db
    .select({ orgId: drives.orgId, orgVisibility: drives.orgVisibility })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);
  if (!drive || drive.orgId === null) return { orgDrive: false };

  const rows = await db
    .select({ role: driveMembers.role, customRoleId: driveMembers.customRoleId, source: driveMembers.source })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.driveId, driveId),
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt),
    ))
    .limit(1);

  return explicitScopeAuthorityRow({ orgsEnabled: true, drive, row: toMembership(rows[0]) });
}

/**
 * One user's ACCEPTED drive_members rows in `driveIds`, keyed by drive, read through `executor` (an
 * org demotion reads them inside the role change's transaction).
 */
export async function loadAcceptedRowsInDrives(
  executor: Pick<typeof db, 'select'>,
  userId: string,
  driveIds: string[],
): Promise<Map<string, OrgDriveMembership>> {
  const rows = new Map<string, OrgDriveMembership>();
  for (const ids of chunks(driveIds)) {
    const found = await executor
      .select({ driveId: driveMembers.driveId, role: driveMembers.role, customRoleId: driveMembers.customRoleId, source: driveMembers.source })
      .from(driveMembers)
      .where(and(eq(driveMembers.userId, userId), isNotNull(driveMembers.acceptedAt), inArray(driveMembers.driveId, ids)));
    for (const r of found) {
      const row = toMembership(r);
      if (row) rows.set(r.driveId, row);
    }
  }
  return rows;
}

/** The user's role in each org they belong to (for listing many drives at once). */
export async function loadOrgRolesForUser(userId: string): Promise<Map<string, OrgRole>> {
  const rows = await db
    .select({ orgId: orgMembers.orgId, role: orgMembers.role })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId));
  return new Map(rows.map((r) => [r.orgId, r.role]));
}

const orgRoleKey = (orgId: string, userId: string) => `${orgId}:${userId}`;

/** Chunk size for the IN lists below (Postgres bind parameter limit). */
const IN_LIST_CHUNK = 500;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_LIST_CHUNK) out.push(items.slice(i, i + IN_LIST_CHUNK));
  return out;
}

async function findOrgRoles(pairs: Array<{ orgId: string; userId: string }>): Promise<Map<string, OrgRole>> {
  const roles = new Map<string, OrgRole>();
  if (pairs.length === 0) return roles;
  const orgIds = [...new Set(pairs.map((p) => p.orgId))];
  for (const userIds of chunks([...new Set(pairs.map((p) => p.userId))])) {
    const rows = await db
      .select({ orgId: orgMembers.orgId, userId: orgMembers.userId, role: orgMembers.role })
      .from(orgMembers)
      .where(and(inArray(orgMembers.orgId, orgIds), inArray(orgMembers.userId, userIds)));
    for (const r of rows) roles.set(orgRoleKey(r.orgId, r.userId), r.role);
  }
  return roles;
}

/** Each drive's default custom role (drive_roles.isDefault), for the drives given. */
async function findDefaultCustomRoleIds(driveIds: string[]): Promise<Map<string, string>> {
  const defaults = new Map<string, string>();
  for (const ids of chunks([...new Set(driveIds)])) {
    const rows = await db
      .select({ driveId: driveRoles.driveId, id: driveRoles.id })
      .from(driveRoles)
      .where(and(inArray(driveRoles.driveId, ids), eq(driveRoles.isDefault, true)));
    for (const r of rows) if (!defaults.has(r.driveId)) defaults.set(r.driveId, r.id);
  }
  return defaults;
}
