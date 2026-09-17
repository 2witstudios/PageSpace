import type { OrgRole } from '@pagespace/db/schema/organizations';
import type { OrgDriveVisibility } from '@pagespace/db/schema/core';
import type { DriveMemberSource } from '@pagespace/db/schema/members';

/**
 * `resolveOrgDriveAccess` — the org branch of drive access (Spec ORG-4, DRV-5..7, POL-6),
 * as ONE pure decision over repository-fetched facts. No IO; the resolvers
 * (getUserAccessLevel, getUserDriveAccess) fetch the facts and call this.
 *
 * - `orgRole` is the user's role in the org that owns the drive; `null` when the user is not
 *   in that org or the drive has no org. A non-member ALWAYS resolves `null` here, even with a
 *   membership row: a guest's row (DRV-8) is resolved by the existing drive-member path, never
 *   by the org path, so the org path cannot widen a guest (X-6).
 * - Org OWNER/ADMIN resolve ADMIN-equivalent on every org drive with source `org-admin`, so the
 *   caller can write the audit event when that access opens a PRIVATE drive (ORG-4, AUD-1). When
 *   their own row already grants ADMIN or OWNER, the row is returned instead: org power was not
 *   used, and a drive lead's OWNER row is never downgraded.
 * - Org MEMBER: an existing membership row resolves as that row. Without one, only an OPEN drive
 *   resolves, to the drive's default role with source `org` (DRV-5, POL-6); RESTRICTED and
 *   PRIVATE resolve `null` (DRV-6, DRV-7).
 * - A `source: 'org'` row counts only on an OPEN drive. On RESTRICTED or PRIVATE only a direct
 *   (`invite`) row, i.e. an invitation or an approved join, grants access; a leftover
 *   materialized row after a visibility change never does (DRV-6, DRV-7).
 *
 * Pure.
 */

export type DriveMemberRole = 'OWNER' | 'ADMIN' | 'MEMBER';

/** A drive role as drive_members stores it: the base role plus an optional custom role. */
export interface DriveRoleGrant {
  role: DriveMemberRole;
  customRoleId: string | null;
}

/** The user's drive_members row for this drive, if any. */
export interface OrgDriveMembership extends DriveRoleGrant {
  source: DriveMemberSource;
}

export interface OrgDriveAccessInput {
  orgRole: OrgRole | null;
  driveVisibility: OrgDriveVisibility;
  driveMembership: OrgDriveMembership | null;
  /** The role an org member holds implicitly on an OPEN drive (POL-6). */
  driveDefaultRole: DriveRoleGrant;
}

/**
 * - `org-admin`: granted by org OWNER/ADMIN (ORG-4); audit when the drive is PRIVATE.
 * - `org`: implicit membership on an OPEN drive (DRV-5), or an org-materialized row.
 * - `invite`: an invited membership row.
 */
export type OrgDriveAccessSource = 'org-admin' | DriveMemberSource;

export interface OrgDriveAccess extends DriveRoleGrant {
  source: OrgDriveAccessSource;
}

export function resolveOrgDriveAccess({
  orgRole,
  driveVisibility,
  driveMembership,
  driveDefaultRole,
}: OrgDriveAccessInput): OrgDriveAccess | null {
  if (orgRole === null) return null;

  // An org-materialized row exists only because the drive is OPEN. On RESTRICTED or PRIVATE it is
  // stale (the visibility changed before the membership sync ran) and grants nothing.
  const row = driveMembership?.source === 'org' && driveVisibility !== 'OPEN' ? null : driveMembership;

  if (orgRole === 'OWNER' || orgRole === 'ADMIN') {
    // A row that already grants ADMIN or OWNER is used as-is: org power is not what opened the
    // drive, so no org-admin audit is owed, and the drive lead's OWNER row is never downgraded.
    if (row?.role === 'OWNER' || row?.role === 'ADMIN') return fromMembership(row);
    return { role: 'ADMIN', customRoleId: null, source: 'org-admin' };
  }

  if (row) return fromMembership(row);

  if (driveVisibility === 'OPEN') {
    return { role: driveDefaultRole.role, customRoleId: driveDefaultRole.customRoleId, source: 'org' };
  }

  return null;
}

function fromMembership({ role, customRoleId, source }: OrgDriveMembership): OrgDriveAccess {
  return { role, customRoleId, source };
}
