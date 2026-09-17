import type { OrgRole } from '@pagespace/db/schema/organizations';
import type { OrgDriveVisibility } from '@pagespace/db/schema/core';
import {
  resolveOrgDriveAccess,
  type DriveMemberRole,
  type DriveRoleGrant,
  type OrgDriveAccess,
  type OrgDriveMembership,
} from './org-access';

/**
 * How the human drive resolvers (getUserAccessLevel, getDriveAccess, getDriveAccessWithDrive,
 * listAccessibleDrives) fold the org branch (resolveOrgDriveAccess) into the drive_members
 * path they already have. Pure: the resolvers fetch the facts and act on the answer.
 *
 * Only humans reach this. Agents (drive_agent_members) and apps with an explicit role
 * (mcp_token_drives) hold no org role and never get org-derived access.
 *
 * While `orgsEnabled` is false, or for a drive with no org, the answer is exactly the accepted
 * row the resolver already read, so the dark resolvers behave as they did before orgs existed.
 */

export interface OrgDriveFacts {
  orgId: string | null;
  orgVisibility: OrgDriveVisibility;
}

export interface EffectiveDriveMembershipInput {
  orgsEnabled: boolean;
  drive: OrgDriveFacts;
  /** The user's role in drive.orgId; null when not a member or the drive has no org. */
  orgRole: OrgRole | null;
  /** The user's ACCEPTED drive_members row for this drive, if any. */
  row: OrgDriveMembership | null;
  /** The role an org member holds implicitly on an OPEN drive (DRV-5, POL-6). */
  driveDefaultRole: DriveRoleGrant;
}

export interface EffectiveDriveMembership extends OrgDriveAccess {
  /** Org Owner/Admin power, not a row, opened a PRIVATE drive: the caller writes the audit event (ORG-4). */
  auditOrgAdminPrivateAccess: boolean;
}

/**
 * Which accepted row still means something on an org drive:
 * - A `source: 'org'` row is materialized only for org members on OPEN drives. Anywhere else it is
 *   stale (a visibility change or a leave the sync has not reached yet) and grants nothing.
 * - An OWNER row is stale on any org drive. The resolvers ask only about users who do not own the
 *   drive (drives.ownerId), so an OWNER row here is a former lead's leftover (the owner self-heal
 *   row outlives a lead reassignment), never an invitation.
 *
 * Exported so the IO edge decides "does this user have a row" (and so whether to fetch the drive's
 * default role) with the same rule the decision applies.
 */
export function validOrgDriveRow(
  row: OrgDriveMembership | null,
  drive: OrgDriveFacts,
  orgRole: OrgRole | null,
): OrgDriveMembership | null {
  if (row?.source === 'org' && (orgRole === null || drive.orgVisibility !== 'OPEN')) return null;
  if (row?.role === 'OWNER') return null;
  return row;
}

export function resolveEffectiveDriveMembership({
  orgsEnabled,
  drive,
  orgRole,
  row,
  driveDefaultRole,
}: EffectiveDriveMembershipInput): EffectiveDriveMembership | null {
  if (!orgsEnabled || drive.orgId === null) {
    return row ? { ...row, auditOrgAdminPrivateAccess: false } : null;
  }

  if (orgRole === null) {
    // A guest (DRV-8) resolves through their own invited row; the org path never widens them.
    const guestRow = validOrgDriveRow(row, drive, orgRole);
    return guestRow ? { ...guestRow, auditOrgAdminPrivateAccess: false } : null;
  }

  const access = resolveOrgDriveAccess({
    orgRole,
    driveVisibility: drive.orgVisibility,
    driveMembership: validOrgDriveRow(row, drive, orgRole),
    driveDefaultRole,
  });
  if (access === null) return null;

  return {
    ...access,
    auditOrgAdminPrivateAccess: access.source === 'org-admin' && drive.orgVisibility === 'PRIVATE',
  };
}

export interface ListedDriveRoleInput {
  orgsEnabled: boolean;
  drive: OrgDriveFacts;
  orgRole: OrgRole | null;
  /** The user's ACCEPTED drive_members row for this drive, if any. */
  row: OrgDriveMembership | null;
  /** The user holds a live canView page permission somewhere in the drive. */
  viaPagePermission: boolean;
}

/**
 * Whether a drive the user does not own belongs in the picker, the sidebar and accessible-drives,
 * and with which role. Returns null when it is not listed.
 *
 * On an org drive only ownership (handled by the caller), a valid row or an OPEN drive of the
 * user's own org lists it (DRV-5, DRV-9). A RESTRICTED or PRIVATE drive is listed only once
 * joined, even for an org Owner or Admin who could open it (DRV-6: the org Drives directory is
 * where they find it). A page permission alone never lists an org drive (X-6).
 */
export function decideListedDriveRole({
  orgsEnabled,
  drive,
  orgRole,
  row,
  viaPagePermission,
}: ListedDriveRoleInput): DriveMemberRole | null {
  if (!orgsEnabled || drive.orgId === null) {
    if (row) return row.role;
    return viaPagePermission ? 'MEMBER' : null;
  }

  const joined = validOrgDriveRow(row, drive, orgRole);
  const implicit = orgRole !== null && drive.orgVisibility === 'OPEN';
  if (!joined && !implicit) return null;

  if (orgRole === null) return joined ? joined.role : null;

  // The listing shows the base role only; a custom role does not change it.
  const access = resolveOrgDriveAccess({
    orgRole,
    driveVisibility: drive.orgVisibility,
    driveMembership: joined,
    driveDefaultRole: { role: 'MEMBER', customRoleId: null },
  });
  return access ? access.role : null;
}
