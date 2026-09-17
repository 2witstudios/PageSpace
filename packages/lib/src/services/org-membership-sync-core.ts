/**
 * Org membership materialization — the pure decision (D-OW-6).
 *
 * An Open org drive gives every org member an implicit membership (DRV-5). Rather than teach every
 * caller that enumerates drive_members (channel recipients, mention search, usersShareDrive,
 * realtime rooms, notifications, backups) a second enumeration, membership is MATERIALIZED as
 * drive_members rows with source 'org'. This module decides which rows to add, remove, or convert;
 * org-membership-sync.ts does the reads, the writes and the events.
 *
 * Invariants:
 * - Only rows with source 'org' are ever removed, converted or repaired. An accepted row with source
 *   'invite' — a guest (DRV-8) or an org member invited directly — is never touched, and it satisfies
 *   the org row an org member would otherwise get (no duplicate, no downgrade).
 * - The one exception is a PENDING invite row (not accepted) held by an org member on an Open drive:
 *   it grants no access, and the unique (driveId, userId) key leaves no room for an org row beside
 *   it, so it is adopted as an accepted org row with the default role — exactly the implicit access
 *   DRV-5 grants, revoked again on leave. A guest's pending row is never adopted.
 * - An org row always carries the drive's current default role and is accepted; drift is repaired.
 * - Keep-as-invited (D-OW-10) applies only once the drive has left its org. On a leave or a
 *   visibility change the row is always deleted, so access is revoked rather than made permanent.
 * - The drive lead never gets a row: ownership lives on drives.ownerId, never in drive_members.
 * - A drive in step plans nothing, so repeated syncs are no-ops.
 */

import type { DriveMemberSource } from '@pagespace/db/schema/members';
import type { OrgDriveVisibility } from '@pagespace/db/schema/core';

export interface OrgSyncDrive {
  id: string;
  ownerId: string;
  /** null once the drive has moved out of its org. */
  orgId: string | null;
  orgVisibility: OrgDriveVisibility;
  /** The drive's default custom role (driveRoles.isDefault), applied to materialized rows (DRV-5). */
  defaultCustomRoleId: string | null;
}

export interface ExistingDriveMemberRow {
  id: string;
  driveId: string;
  userId: string;
  source: DriveMemberSource;
  customRoleId: string | null;
  /** acceptedAt IS NOT NULL: only accepted rows grant access. */
  accepted: boolean;
}

/**
 * What happens to an org-sourced row that should no longer exist once its drive has moved out of the
 * org (D-OW-10): 'keepAsInvite' turns the implicit members into ordinary invited members. Ignored
 * while the drive is still in an org, where a stale row is always deleted.
 */
export type RemovedOrgRowsMode = 'delete' | 'keepAsInvite';

export interface PlanDriveOrgMembershipInput {
  drive: OrgSyncDrive;
  /** Current members of drive.orgId; ignored when the drive has no org. */
  orgMemberUserIds: readonly string[];
  /** drive_members rows already present; rows of other drives are ignored. */
  existingRows: readonly ExistingDriveMemberRow[];
  /** When set, only these users are considered (a join or a leave). */
  userScope?: readonly string[];
  removedOrgRows?: RemovedOrgRowsMode;
}

export interface OrgRowInsert {
  driveId: string;
  userId: string;
  customRoleId: string | null;
}

export interface OrgRowChange {
  rowId: string;
  driveId: string;
  userId: string;
}

export interface OrgRowUpdate extends OrgRowChange {
  customRoleId: string | null;
}

export interface DriveOrgMembershipPlan {
  driveId: string;
  inserts: OrgRowInsert[];
  deletes: OrgRowChange[];
  /** Org rows turned into invited rows (D-OW-10 keep-as-invited). */
  conversions: OrgRowChange[];
  /** Org rows set back to the default role and accepted. */
  repairs: OrgRowUpdate[];
  /** An org member's pending invite rows, made accepted org rows with the default role. */
  adoptions: OrgRowUpdate[];
}

export function planDriveOrgMembership({
  drive,
  orgMemberUserIds,
  existingRows,
  userScope,
  removedOrgRows = 'delete',
}: PlanDriveOrgMembershipInput): DriveOrgMembershipPlan {
  const scope = userScope ? new Set(userScope) : null;
  const inScope = (userId: string) => scope === null || scope.has(userId);

  const materializes = drive.orgId !== null && drive.orgVisibility === 'OPEN';
  const desired = new Set(
    materializes ? orgMemberUserIds.filter((userId) => userId !== drive.ownerId && inScope(userId)) : [],
  );

  const rows = existingRows.filter((r) => r.driveId === drive.id && inScope(r.userId));
  const usersWithRow = new Set(rows.map((r) => r.userId));
  const withDefaultRole = (r: ExistingDriveMemberRow): OrgRowUpdate => ({
    rowId: r.id,
    driveId: drive.id,
    userId: r.userId,
    customRoleId: drive.defaultCustomRoleId,
  });

  const inserts = [...desired]
    .filter((userId) => !usersWithRow.has(userId))
    .map((userId) => ({ driveId: drive.id, userId, customRoleId: drive.defaultCustomRoleId }));

  const orgRows = rows.filter((r) => r.source === 'org');
  const stale = orgRows
    .filter((r) => !desired.has(r.userId))
    .map((r) => ({ rowId: r.id, driveId: drive.id, userId: r.userId }));
  const keepStale = removedOrgRows === 'keepAsInvite' && drive.orgId === null;

  const repairs = orgRows
    .filter((r) => desired.has(r.userId) && (!r.accepted || r.customRoleId !== drive.defaultCustomRoleId))
    .map(withDefaultRole);
  const adoptions = rows
    .filter((r) => r.source === 'invite' && !r.accepted && desired.has(r.userId))
    .map(withDefaultRole);

  return {
    driveId: drive.id,
    inserts,
    deletes: keepStale ? [] : stale,
    conversions: keepStale ? stale : [],
    repairs,
    adoptions,
  };
}

export type OrgSyncEventOperation = 'member_added' | 'member_removed' | 'member_role_changed';

export interface AffectedUser {
  userId: string;
  operation: OrgSyncEventOperation;
  driveIds: string[];
}

// A removal outranks an addition: whichever event arrives, the client refetches its drive list,
// but a removal is the one a lingering view must not miss.
const OPERATION_RANK: Record<OrgSyncEventOperation, number> = {
  member_role_changed: 0,
  member_added: 1,
  member_removed: 2,
};

/** One entry per affected user across every drive in a sync, in first-seen order (X-4). */
export function summarizeAffectedUsers(plans: readonly DriveOrgMembershipPlan[]): AffectedUser[] {
  const byUser = new Map<string, AffectedUser>();
  const note = (userId: string, driveId: string, operation: OrgSyncEventOperation) => {
    const entry = byUser.get(userId);
    if (!entry) {
      byUser.set(userId, { userId, operation, driveIds: [driveId] });
      return;
    }
    if (!entry.driveIds.includes(driveId)) entry.driveIds.push(driveId);
    if (OPERATION_RANK[operation] > OPERATION_RANK[entry.operation]) entry.operation = operation;
  };

  for (const plan of plans) {
    plan.inserts.forEach((i) => note(i.userId, i.driveId, 'member_added'));
    plan.adoptions.forEach((a) => note(a.userId, a.driveId, 'member_added'));
    plan.deletes.forEach((d) => note(d.userId, d.driveId, 'member_removed'));
    plan.conversions.forEach((c) => note(c.userId, c.driveId, 'member_role_changed'));
    plan.repairs.forEach((r) => note(r.userId, r.driveId, 'member_role_changed'));
  }
  return [...byUser.values()];
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunk size must be a positive integer, got ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Run tasks batch by batch, at most `size` at once, settling every one. A large sync removes
 * hundreds of rows, and each removal's room kick enumerates the drive's pages; firing them all at
 * once would exhaust the connection pool.
 */
export async function settleInBatches<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  size: number,
): Promise<PromiseSettledResult<T>[]> {
  const settled: PromiseSettledResult<T>[] = [];
  for (const batch of chunk(tasks, size)) {
    settled.push(...(await Promise.allSettled(batch.map((task) => task()))));
  }
  return settled;
}
