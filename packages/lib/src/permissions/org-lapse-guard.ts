/**
 * [D-OW-33] the lapse guard at drive-level write sites: a lapsed org may only RESTRICT access (SEAT-9 as amended).
 *
 * Every helper here ends in the ONE guard, `checkOrgMayLoosen` (organizations/status.ts), and returns or throws the
 * same refusal (`org_lapsed`, 402, the SEAT-9 copy). A personal drive (no org) has no lapse and is never refused.
 *
 *   - checkDriveMayLoosen / checkPageMayLoosen: the write already knows whether it loosens (a new member, a new share
 *     link, an invitation accepted); they only find the drive's org, in the write's executor.
 *   - guardDriveAccess: the write does not know (a rollback, a backup restore, a role edit, a re-invite that may
 *     raise or lower). It snapshots who reaches the drive before and after the write, INSIDE a transaction (a
 *     savepoint when handed one), and when the write gave anyone more (driveAccessWidens) and the org is lapsed it
 *     throws OrgLapsedError, so nothing the write did is kept.
 *
 * This module reads drive_members, so it lives in the permission layer (the drive-members enumeration seam).
 */
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers, driveMembers, driveRoles, pagePermissions } from '@pagespace/db/schema/members';
import { driveAccessWidens, type DriveAccessSnapshot, type DriveMemberRoleName, type GrantFlags } from '../organizations/loosening-core';
import { checkOrgMayLoosen, ORG_LAPSED_CODE, ORG_LAPSED_MESSAGE, type OrgLapsedRefusal } from '../organizations/status';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

/** The lapse refusal as an exception, for a write that must roll back what it did (guardDriveAccess). */
export class OrgLapsedError extends Error {
  readonly code = ORG_LAPSED_CODE;
  readonly status = 402 as const;
  constructor() {
    super(ORG_LAPSED_MESSAGE);
    this.name = 'OrgLapsedError';
  }
}

export function isOrgLapsedError(error: unknown): error is OrgLapsedError {
  return error instanceof OrgLapsedError;
}

/** [D-OW-33] checkOrgMayLoosen for a write on a drive: the drive's org read in `executor`; a personal drive is never refused. */
export async function checkDriveMayLoosen(executor: Executor, driveId: string, loosens: boolean): Promise<OrgLapsedRefusal | null> {
  if (!loosens) return null;
  const [row] = await executor.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, driveId)).limit(1);
  return row?.orgId ? checkOrgMayLoosen(executor, row.orgId, true) : null;
}

/** [D-OW-33] checkOrgMayLoosen for a write on a page: its drive's org, read in `executor`. */
export async function checkPageMayLoosen(executor: Executor, pageId: string, loosens: boolean): Promise<OrgLapsedRefusal | null> {
  if (!loosens) return null;
  const [row] = await executor
    .select({ orgId: drives.orgId })
    .from(pages)
    .innerJoin(drives, eq(drives.id, pages.driveId))
    .where(eq(pages.id, pageId))
    .limit(1);
  return row?.orgId ? checkOrgMayLoosen(executor, row.orgId, true) : null;
}

/** Which part of a drive a guarded write can touch. Both snapshots of one write use the same scope. */
export interface DriveAccessScope {
  /** Only these people's member rows and page grants (default: everyone on the drive). */
  users?: readonly string[];
  /** Read member rows (default true). */
  members?: boolean;
  /** Read page grants (default true). */
  grants?: boolean;
  /** Read agent memberships (default true). */
  agents?: boolean;
}

const asRole = (role: string): DriveMemberRoleName => (role === 'OWNER' || role === 'ADMIN' || role === 'GUEST' ? role : 'MEMBER');

/** Who reaches the drive right now, within `scope`, read in `executor`. */
export async function snapshotDriveAccess(executor: Executor, driveId: string, scope: DriveAccessScope = {}): Promise<DriveAccessSnapshot> {
  const users = scope.users ? [...scope.users] : null;
  const [drive] = await executor
    .select({ ownerId: drives.ownerId, orgId: drives.orgId, orgVisibility: drives.orgVisibility })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);

  const roleRows = await executor
    .select({ id: driveRoles.id, permissions: driveRoles.permissions, driveWide: driveRoles.driveWidePermissions, isDefault: driveRoles.isDefault })
    .from(driveRoles)
    .where(eq(driveRoles.driveId, driveId));
  const roles: DriveAccessSnapshot['roles'] = {};
  for (const r of roleRows) {
    roles[r.id] = {
      grant: { permissions: (r.permissions as Record<string, GrantFlags> | null) ?? {}, driveWidePermissions: (r.driveWide as GrantFlags | null) ?? null },
      isDefault: r.isDefault,
    };
  }

  const members: DriveAccessSnapshot['members'] = {};
  if (scope.members !== false && (users === null || users.length > 0)) {
    const rows = await executor
      .select({ userId: driveMembers.userId, role: driveMembers.role, customRoleId: driveMembers.customRoleId, acceptedAt: driveMembers.acceptedAt })
      .from(driveMembers)
      .where(users === null ? eq(driveMembers.driveId, driveId) : and(eq(driveMembers.driveId, driveId), inArray(driveMembers.userId, users)));
    for (const m of rows) members[m.userId] = { role: asRole(m.role), customRoleId: m.customRoleId, accepted: m.acceptedAt !== null };
  }

  const grants: DriveAccessSnapshot['grants'] = {};
  if (scope.grants !== false && (users === null || users.length > 0)) {
    const rows = await executor
      .select({ pageId: pagePermissions.pageId, userId: pagePermissions.userId, canView: pagePermissions.canView, canEdit: pagePermissions.canEdit, canShare: pagePermissions.canShare, canDelete: pagePermissions.canDelete })
      .from(pagePermissions)
      .innerJoin(pages, eq(pages.id, pagePermissions.pageId))
      .where(users === null ? eq(pages.driveId, driveId) : and(eq(pages.driveId, driveId), inArray(pagePermissions.userId, users)));
    for (const g of rows) grants[`${g.pageId}:${g.userId}`] = { canView: g.canView, canEdit: g.canEdit, canShare: g.canShare, canDelete: g.canDelete };
  }

  const agents: DriveAccessSnapshot['agents'] = {};
  if (scope.agents !== false) {
    const rows = await executor
      .select({ agentPageId: driveAgentMembers.agentPageId, role: driveAgentMembers.role, customRoleId: driveAgentMembers.customRoleId, includeContext: driveAgentMembers.includeContext })
      .from(driveAgentMembers)
      .where(eq(driveAgentMembers.driveId, driveId));
    for (const a of rows) agents[a.agentPageId] = { role: asRole(a.role), customRoleId: a.customRoleId, includeContext: a.includeContext };
  }

  return {
    drive: drive ? { leadId: drive.ownerId, orgId: drive.orgId, orgVisibility: drive.orgVisibility } : null,
    members,
    grants,
    roles,
    agents,
  };
}

/**
 * [D-OW-33] Run `write` (handed the transaction to write with) and keep it only if it loosens nothing, or the drive's
 * org is paid. Opens a transaction on `db`, or a savepoint inside a caller's transaction, so a refusal (OrgLapsedError,
 * thrown) undoes exactly this write even when the caller catches it. The drive's org is read before AND after, so a
 * write that moves the drive between orgs is judged against both.
 */
export async function guardDriveAccess<T>(
  executor: Executor,
  driveId: string,
  scope: DriveAccessScope,
  write: (tx: Tx) => Promise<T>,
): Promise<T> {
  return executor.transaction(async (tx) => {
    const before = await snapshotDriveAccess(tx, driveId, scope);
    const result = await write(tx);
    const after = await snapshotDriveAccess(tx, driveId, scope);
    const loosens = driveAccessWidens(before, after);
    const orgIds = new Set([before.drive?.orgId, after.drive?.orgId].filter((id): id is string => Boolean(id)));
    for (const orgId of orgIds) {
      if (await checkOrgMayLoosen(tx, orgId, loosens)) throw new OrgLapsedError();
    }
    return result;
  });
}
