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
 * - Only rows with source 'org' are ever removed or converted. A row with source 'invite' — a guest
 *   (DRV-8) or an org member invited directly — is never touched, and it satisfies the org row an
 *   org member would otherwise get (no duplicate, no downgrade).
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
}

/**
 * What happens to an org-sourced row that should no longer exist. 'delete' on leave and on a
 * visibility change away from Open; a move out of the org offers either (D-OW-10), where
 * 'keepAsInvite' turns the implicit members into ordinary invited members.
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

export interface DriveOrgMembershipPlan {
  driveId: string;
  inserts: OrgRowInsert[];
  deletes: OrgRowChange[];
  conversions: OrgRowChange[];
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

  const inserts = [...desired]
    .filter((userId) => !usersWithRow.has(userId))
    .map((userId) => ({ driveId: drive.id, userId, customRoleId: drive.defaultCustomRoleId }));

  const stale = rows
    .filter((r) => r.source === 'org' && !desired.has(r.userId))
    .map((r) => ({ rowId: r.id, driveId: drive.id, userId: r.userId }));

  return {
    driveId: drive.id,
    inserts,
    deletes: removedOrgRows === 'delete' ? stale : [],
    conversions: removedOrgRows === 'keepAsInvite' ? stale : [],
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
    plan.deletes.forEach((d) => note(d.userId, d.driveId, 'member_removed'));
    plan.conversions.forEach((c) => note(c.userId, c.driveId, 'member_role_changed'));
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
