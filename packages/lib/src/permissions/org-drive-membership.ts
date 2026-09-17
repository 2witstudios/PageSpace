import { db } from '@pagespace/db/db';
import { and, eq, isNotNull } from '@pagespace/db/operators';
import type { OrgDriveVisibility } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles } from '@pagespace/db/schema/members';
import { orgMembers, type OrgRole } from '@pagespace/db/schema/organizations';
import { audit } from '../audit/audit-log';
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

  const row = toMembership(rows[0]);

  const orgId = drive.orgId ?? null;
  if (!ORGS_ENABLED || orgId === null) {
    return resolveEffectiveDriveMembership({
      orgsEnabled: false,
      drive: { orgId, orgVisibility: drive.orgVisibility ?? 'OPEN' },
      orgRole: null,
      row,
      driveDefaultRole: NO_DEFAULT_ROLE,
    });
  }

  const orgVisibility = drive.orgVisibility ?? 'OPEN';
  const orgRole = await findOrgRole(orgId, userId);
  // A stale row (a misplaced org row, a former lead's OWNER row) counts as no row here too, or the
  // member would resolve the implicit OPEN membership without the drive's default role.
  const hasValidRow = validOrgDriveRow(row, { orgId, orgVisibility }, orgRole) !== null;
  const needsDefaultRole = orgRole === 'MEMBER' && orgVisibility === 'OPEN' && !hasValidRow;
  const driveDefaultRole = needsDefaultRole
    ? { role: 'MEMBER' as const, customRoleId: await findDefaultCustomRoleId(drive.id) }
    : NO_DEFAULT_ROLE;

  const effective = resolveEffectiveDriveMembership({
    orgsEnabled: true,
    drive: { orgId, orgVisibility },
    orgRole,
    row,
    driveDefaultRole,
  });

  if (effective?.auditOrgAdminPrivateAccess && orgRole !== null) {
    auditOrgAdminPrivateDriveAccess({ userId, driveId: drive.id, orgId, orgRole });
  }

  return effective;
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

/** The user's role in each org they belong to (for listing many drives at once). */
export async function loadOrgRolesForUser(userId: string): Promise<Map<string, OrgRole>> {
  const rows = await db
    .select({ orgId: orgMembers.orgId, role: orgMembers.role })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId));
  return new Map(rows.map((r) => [r.orgId, r.role]));
}

async function findOrgRole(orgId: string, userId: string): Promise<OrgRole | null> {
  const [row] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

async function findDefaultCustomRoleId(driveId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: driveRoles.id })
    .from(driveRoles)
    .where(and(eq(driveRoles.driveId, driveId), eq(driveRoles.isDefault, true)))
    .limit(1);
  return row?.id ?? null;
}

/** ORG-4, AUD-1: an org Owner or Admin used org power, not a membership row, on a PRIVATE drive. */
function auditOrgAdminPrivateDriveAccess({
  userId,
  driveId,
  orgId,
  orgRole,
}: {
  userId: string;
  driveId: string;
  orgId: string;
  orgRole: OrgRole;
}): void {
  audit({
    eventType: 'authz.access.granted',
    userId,
    resourceType: 'drive',
    resourceId: driveId,
    details: { via: 'org_admin', orgId, orgRole, orgVisibility: 'PRIVATE' },
  });
}
