/**
 * POL-6 (D-OW-11): the org's floor under the default role of its OPEN drives, enforced at every WRITE that can
 * leave an Open org drive's default below it (point-guard ruling, 2026-10-04: no resolution-time overlay).
 *
 * The default role org members hold implicitly in an Open drive is the drive's default custom role, or, with none,
 * the plain MEMBER role (view of every non-private page). The floor is the least that default may grant drive-wide.
 *
 * The write points, each judged inside its own transaction with the org row held at least FOR SHARE (the policy
 * writer holds it FOR UPDATE, so a floor change and a default change serialize):
 * - a role write that makes, changes or removes a drive's default (drive-role-service, backup restore, role
 *   rollback and redo): guardOpenRoleFloor, a post-condition on the drive's state;
 * - a drive becoming an Open org drive (create, move into the org, visibility change): openDriveFloorRefusal;
 * - raising the floor (updateOrgPolicies): openDrivesBelowFloor lists the drives that would fall below it.
 */
import { db } from '@pagespace/db/db';
import { and, asc, eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveRoles } from '@pagespace/db/schema/members';
import type { OrgDriveVisibility } from '@pagespace/db/schema/core';
import { getOrgPolicies } from './policy-reader';
import { OPEN_ROLE_FLOOR_MESSAGES, openDefaultRoleMeetsFloor, type OpenRoleFloor } from './policies-core';
import { policyRefusal, type PolicyRefusal } from './sharing-decisions';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;
type DriveWide = { canView: boolean; canEdit: boolean; canShare: boolean } | null;

/** What the plain MEMBER role (a drive with no default custom role) grants drive-wide: view, never edit. */
const PLAIN_MEMBER_DRIVE_WIDE = { canView: true, canEdit: false, canShare: false } as const;

/**
 * Does an Open drive's default meet the floor? `defaultRole` null means the drive has no default custom role, so
 * org members hold the plain MEMBER role.
 */
export function openDriveDefaultMeetsFloor(floor: OpenRoleFloor, defaultRole: { driveWide: DriveWide } | null): boolean {
  return openDefaultRoleMeetsFloor(floor, defaultRole ? defaultRole.driveWide : PLAIN_MEMBER_DRIVE_WIDE);
}

/** POL-6 refused a write: names the policy and the floor, like every org-policy refusal. */
export class OpenRoleFloorError extends Error {
  readonly code = 'org_policy' as const;
  readonly policy = 'openDriveRoleFloor' as const;
  readonly status = 403 as const;
  constructor(readonly floor: OpenRoleFloor) {
    super(OPEN_ROLE_FLOOR_MESSAGES[floor]);
    this.name = 'OpenRoleFloorError';
  }
}

export const openRoleFloorRefusal = (floor: OpenRoleFloor): PolicyRefusal => policyRefusal('openDriveRoleFloor', OPEN_ROLE_FLOOR_MESSAGES[floor]);

async function defaultRoleOf(executor: Executor, driveId: string): Promise<{ id: string; driveWide: DriveWide } | null> {
  const [role] = await executor
    .select({ id: driveRoles.id, driveWide: driveRoles.driveWidePermissions })
    .from(driveRoles)
    .where(and(eq(driveRoles.driveId, driveId), eq(driveRoles.isDefault, true)))
    .orderBy(asc(driveRoles.position), asc(driveRoles.id))
    .limit(1);
  return role ? { id: role.id, driveWide: (role.driveWide as DriveWide) ?? null } : null;
}

interface FloorState {
  /** An Open org drive: the floor governs it. */
  governed: boolean;
  floor: OpenRoleFloor;
  meets: boolean;
  /** Identifies the default and its drive-wide grant, to tell whether a write changed them. */
  key: string;
}

async function floorState(tx: Executor, driveId: string): Promise<FloorState> {
  const [drive] = await tx.select({ orgId: drives.orgId, orgVisibility: drives.orgVisibility }).from(drives).where(eq(drives.id, driveId)).limit(1);
  const role = await defaultRoleOf(tx, driveId);
  const key = JSON.stringify(role);
  if (!drive?.orgId || drive.orgVisibility !== 'OPEN') return { governed: false, floor: 'view', meets: true, key };
  const floor = (await getOrgPolicies(drive.orgId, tx, { forShare: true })).openDriveRoleFloor;
  return { governed: true, floor, meets: openDriveDefaultMeetsFloor(floor, role), key };
}

/**
 * Run a role write and refuse it (OpenRoleFloorError, thrown inside the transaction so nothing is written) when it
 * leaves an Open org drive's default below the floor. A drive that was already below the floor (before this was
 * enforced) is refused only when the write touches its default or that default's drive-wide grant: editing an
 * unrelated role there is not blocked. Pass the write's TRANSACTION: refusing after the write relies on the
 * rollback.
 */
export async function guardOpenRoleFloor<T>(tx: Executor, driveId: string, write: () => Promise<T>): Promise<T> {
  const before = await floorState(tx, driveId);
  const result = await write();
  const after = await floorState(tx, driveId);
  if (after.governed && !after.meets && (before.meets || before.key !== after.key)) throw new OpenRoleFloorError(after.floor);
  return result;
}

/**
 * A drive is about to be an Open drive of `orgId` (created Open, moved in as Open, or switched to Open): refused
 * when its default (none, for a new drive) is below the org's floor. Call with the org row already locked.
 */
export async function openDriveFloorRefusal(
  tx: Tx,
  input: { driveId: string | null; orgId: string; visibilityAfter: OrgDriveVisibility },
): Promise<PolicyRefusal | null> {
  if (input.visibilityAfter !== 'OPEN') return null;
  const floor = (await getOrgPolicies(input.orgId, tx, { forShare: true })).openDriveRoleFloor;
  const role = input.driveId ? await defaultRoleOf(tx, input.driveId) : null;
  return openDriveDefaultMeetsFloor(floor, role) ? null : openRoleFloorRefusal(floor);
}

/** The org's Open drives whose default is below `floor` (bounded): raising the floor to it is refused while any exist. */
export async function openDrivesBelowFloor(tx: Tx, orgId: string, floor: OpenRoleFloor, limit = 50): Promise<Array<{ id: string; name: string }>> {
  const rows = await tx
    .select({ id: drives.id, name: drives.name, roleId: driveRoles.id, driveWide: driveRoles.driveWidePermissions })
    .from(drives)
    .leftJoin(driveRoles, and(eq(driveRoles.driveId, drives.id), eq(driveRoles.isDefault, true)))
    .where(and(eq(drives.orgId, orgId), eq(drives.orgVisibility, 'OPEN')))
    .orderBy(asc(drives.name), asc(drives.id), asc(driveRoles.position), asc(driveRoles.id));
  const below: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const role = r.roleId ? { driveWide: (r.driveWide as DriveWide) ?? null } : null;
    if (!openDriveDefaultMeetsFloor(floor, role)) below.push({ id: r.id, name: r.name });
    if (below.length >= limit) break;
  }
  return below;
}
