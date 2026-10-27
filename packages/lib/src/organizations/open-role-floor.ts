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
import { and, asc, eq, sql } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveRoles } from '@pagespace/db/schema/members';
import { organizations } from '@pagespace/db/schema/organizations';
import { followDriveDefaultRole } from '../permissions/org-drive-membership';
import { driveAccessLockKey } from '../permissions/org-lapse-guard';
import type { OrgDriveVisibility } from '@pagespace/db/schema/core';
import { getOrgPolicies } from './policy-reader';
import { OPEN_ROLE_FLOOR_MESSAGES, openDefaultRoleMeetsFloor, type OpenRoleFloor } from './policies-core';
import { policyRefusal, type PolicyRefusal } from './sharing-decisions';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;
type DriveWide = { canView: boolean; canEdit: boolean; canShare: boolean } | null;
type PageGrants = Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>;
type DefaultRole = { id: string; driveWide: DriveWide; pages: PageGrants };

/**
 * Does an Open drive's default meet the floor? `defaultRole` null means the drive has no default custom role, so
 * org members hold the plain MEMBER role (view of every non-private page).
 */
export function openDriveDefaultMeetsFloor(floor: OpenRoleFloor, defaultRole: { driveWide: DriveWide; pages?: PageGrants } | null): boolean {
  return defaultRole ? openDefaultRoleMeetsFloor(floor, defaultRole.driveWide, defaultRole.pages ?? {}) : openDefaultRoleMeetsFloor(floor, null);
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

/** The drive's default custom role, picked deterministically (lowest position, then id) as the resolver picks it. */
async function defaultRoleOf(executor: Executor, driveId: string): Promise<DefaultRole | null> {
  const [role] = await executor
    .select({ id: driveRoles.id, driveWide: driveRoles.driveWidePermissions, pages: driveRoles.permissions })
    .from(driveRoles)
    .where(and(eq(driveRoles.driveId, driveId), eq(driveRoles.isDefault, true)))
    .orderBy(asc(driveRoles.position), asc(driveRoles.id))
    .limit(1);
  return role ? { id: role.id, driveWide: (role.driveWide as DriveWide) ?? null, pages: (role.pages as PageGrants | null) ?? {} } : null;
}

interface FloorState {
  /** An Open org drive: the floor governs it. */
  governed: boolean;
  floor: OpenRoleFloor;
  meets: boolean;
  /** The default role's id, or null when the drive has none. */
  defaultId: string | null;
  /** Identifies the default and its effective grants, to tell whether a write changed them. */
  key: string;
}

async function floorState(tx: Executor, driveId: string): Promise<FloorState> {
  const [drive] = await tx.select({ orgId: drives.orgId, orgVisibility: drives.orgVisibility }).from(drives).where(eq(drives.id, driveId)).limit(1);
  const role = await defaultRoleOf(tx, driveId);
  const key = JSON.stringify(role);
  const defaultId = role?.id ?? null;
  if (!drive?.orgId || drive.orgVisibility !== 'OPEN') return { governed: false, floor: 'view', meets: true, defaultId, key };
  const floor = (await getOrgPolicies(drive.orgId, tx)).openDriveRoleFloor;
  return { governed: true, floor, meets: openDriveDefaultMeetsFloor(floor, role), defaultId, key };
}

/**
 * The locks a role write takes before it reads the drive's state, in the order every org-drive path takes them
 * (lockDriveWithOrg): the org row FOR SHARE (the policy writer holds it FOR UPDATE), the drive row FOR SHARE (a
 * visibility change or a move-in holds it FOR UPDATE, Review #2762 P2-2), then a per-drive advisory lock so two role
 * writes on one drive never interleave (two defaults, P3-3).
 */
class OrgChangedUnderLock extends Error {}

async function lockForRoleWrite(tx: Executor, driveId: string): Promise<void> {
  // The drive's org is read before its row is locked; a drive moved into an org at that moment would leave the org
  // unlocked. So the org is re-read under the drive lock, and if it changed the locks are taken again in the same
  // order inside a fresh savepoint (rolling a savepoint back releases the locks it took). Re-verify N9.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const settled = await tx.transaction(async (sp) => {
      const [current] = await sp.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, driveId)).limit(1);
      if (current?.orgId) await sp.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, current.orgId)).for('share');
      const [locked] = await sp.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, driveId)).for('share');
      // Throwing rolls the savepoint back, which releases the locks it took.
      if ((locked?.orgId ?? null) !== (current?.orgId ?? null)) throw new OrgChangedUnderLock();
      return true;
    }).catch((error: unknown) => {
      if (error instanceof OrgChangedUnderLock) return false;
      throw error;
    });
    if (settled) {
      // The same key guardDriveAccess takes first ([D-OW-33]), so a lapse-guarded write and a role write serialize.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${driveAccessLockKey(driveId)}, 0))`);
      return;
    }
  }
  throw new Error(`The drive ${driveId} kept changing organization while a role write waited for it`);
}

/**
 * Run a role write and refuse it (OpenRoleFloorError, thrown inside the transaction so nothing is written) when it
 * leaves an Open org drive's default below the floor, judged on what the default EFFECTIVELY grants (its drive-wide
 * grant and every per-page entry). A drive that was already below the floor is refused only when the write touches
 * its default: editing an unrelated role there is not blocked. When the write changes WHICH role is the default (or
 * removes it), org members materialized on the drive follow the new default in the same transaction (P2-3). Pass
 * the write's TRANSACTION: refusing after the write relies on the rollback.
 */
export async function guardOpenRoleFloor<T>(tx: Executor, driveId: string, write: () => Promise<T>): Promise<T> {
  await lockForRoleWrite(tx, driveId);
  const before = await floorState(tx, driveId);
  const result = await write();
  const after = await floorState(tx, driveId);
  if (after.governed && !after.meets && (before.meets || before.key !== after.key)) throw new OpenRoleFloorError(after.floor);
  if (after.defaultId !== before.defaultId) await followDriveDefaultRole(tx, driveId, before.defaultId, after.defaultId);
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
    .select({ id: drives.id, name: drives.name, roleId: driveRoles.id, driveWide: driveRoles.driveWidePermissions, pages: driveRoles.permissions })
    .from(drives)
    .leftJoin(driveRoles, and(eq(driveRoles.driveId, drives.id), eq(driveRoles.isDefault, true)))
    .where(and(eq(drives.orgId, orgId), eq(drives.orgVisibility, 'OPEN')))
    .orderBy(asc(drives.name), asc(drives.id), asc(driveRoles.position), asc(driveRoles.id));
  const below: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const role = r.roleId ? { driveWide: (r.driveWide as DriveWide) ?? null, pages: (r.pages as PageGrants | null) ?? {} } : null;
    if (!openDriveDefaultMeetsFloor(floor, role)) below.push({ id: r.id, name: r.name });
    if (below.length >= limit) break;
  }
  return below;
}
