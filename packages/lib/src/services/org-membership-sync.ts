/**
 * Org membership materialization — reads, writes and events (D-OW-6).
 *
 * The decision of which drive_members rows to add, remove or convert lives in
 * org-membership-sync-core.ts. This module is the thin IO around it:
 *
 * - syncOrgMembership(orgId)              every drive of an org (org-wide repair, move-in batches)
 * - syncOrgMemberAccess(orgId, userId)    one user across the org's drives (join, leave)
 * - syncDriveOrgMembership(driveId)       one drive (visibility change, move in, move out)
 *
 * Every entry point locks the drive rows it plans for (SELECT … FOR UPDATE, in id order) and
 * reads membership and rows under that lock, so concurrent syncs serialize per drive and the
 * last one to run sees the latest visibility and org membership. Writes re-check source = 'org'
 * in SQL, so a stale plan can never remove or convert an invited row.
 * A caller passing `tx` that already holds a lock on one of those drives (it just updated
 * orgVisibility or orgId) is safe: Postgres re-grants its own row lock. Two such callers locking
 * different drives first can deadlock; Postgres aborts one and the caller retries.
 *
 * Events: one `drive:<operation>` broadcast per affected user on `user:<id>:drives` (X-4), plus a
 * realtime room kick for each removed row. Without `tx` the sync commits its own transaction and
 * publishes after commit. With `tx` nothing is published: the caller commits, then calls
 * publishOrgMembershipSyncEvents(result).
 */

import { db } from '@pagespace/db/db';
import { and, asc, eq, inArray, sql } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles } from '@pagespace/db/schema/members';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { createSignedBroadcastHeaders } from '../auth/broadcast-auth';
import { loggers } from '../logging/logger-config';
import { kickForDriveMembershipRevocation } from '../permissions/revocation-kick';
import {
  chunk,
  planDriveOrgMembership,
  settleInBatches,
  summarizeAffectedUsers,
  type AffectedUser,
  type DriveOrgMembershipPlan,
  type ExistingDriveMemberRow,
  type OrgRowChange,
  type OrgRowUpdate,
  type OrgSyncDrive,
  type RemovedOrgRowsMode,
} from './org-membership-sync-core';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Rows per bulk statement: 500 × 8 columns stays far under Postgres's 65,535 bind parameters. */
const WRITE_CHUNK = 500;

/** Broadcasts and room kicks in flight at once after a sync. */
const EVENT_CONCURRENCY = 20;

export interface OrgMembershipSyncPorts {
  broadcast: (user: AffectedUser) => Promise<void>;
  kick: (target: { userId: string; driveId: string }) => Promise<void>;
}

export interface OrgMembershipSyncOptions {
  /** Run inside the caller's transaction; events are then left to publishOrgMembershipSyncEvents. */
  tx?: Tx;
  ports?: OrgMembershipSyncPorts;
}

export interface DriveOrgMembershipSyncOptions extends OrgMembershipSyncOptions {
  /**
   * After a move out of the org, what happens to its org rows (D-OW-10). Defaults to 'delete'.
   * Ignored while the drive is still in an org: a leave or a visibility change always revokes.
   */
  removedOrgRows?: RemovedOrgRowsMode;
}

export interface OrgMembershipSyncResult {
  plans: DriveOrgMembershipPlan[];
  /** One entry per affected user, the unit of the realtime event. */
  affectedUsers: AffectedUser[];
  /** Rows deleted, each a realtime room revocation. */
  removedRows: OrgRowChange[];
}

async function broadcastAffectedUser(user: AffectedUser): Promise<void> {
  const realtimeUrl = process.env.INTERNAL_REALTIME_URL;
  if (!realtimeUrl) return;
  // Shape matches DriveMemberEventPayload (apps/web socket-utils) with the extra driveIds, so the
  // sidebar and picker listeners on user:<id>:drives refetch unchanged.
  const requestBody = JSON.stringify({
    channelId: `user:${user.userId}:drives`,
    event: `drive:${user.operation}`,
    payload: { driveId: user.driveIds[0], driveIds: user.driveIds, userId: user.userId, operation: user.operation },
  });
  const response = await fetch(`${realtimeUrl}/api/broadcast`, {
    method: 'POST',
    headers: createSignedBroadcastHeaders(requestBody),
    body: requestBody,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`realtime broadcast failed: ${response.status}`);
}

const defaultPorts: OrgMembershipSyncPorts = {
  broadcast: broadcastAffectedUser,
  kick: ({ userId, driveId }) => kickForDriveMembershipRevocation({ userId, driveId, reason: 'member_removed' }),
};

/** Publish a sync's events. Best-effort: never throws, since the membership change has committed. */
export function publishOrgMembershipSyncEvents(
  result: OrgMembershipSyncResult,
  ports: OrgMembershipSyncPorts = defaultPorts,
): Promise<void> {
  return publishDriveAccessEvents({ affectedUsers: result.affectedUsers, revoked: result.removedRows }, ports);
}

/**
 * The drive-list event for each affected user plus a room kick for each (person, drive) whose access
 * ended, at most EVENT_CONCURRENCY at a time. Also used where access ends with no row to delete (org
 * deletion ends rowless org Owner/Admin and implicit Open-drive access). Best-effort: never throws.
 */
export async function publishDriveAccessEvents(
  events: { affectedUsers: readonly AffectedUser[]; revoked: ReadonlyArray<{ userId: string; driveId: string }> },
  ports: OrgMembershipSyncPorts = defaultPorts,
): Promise<void> {
  const settled = await settleInBatches(
    [
      ...events.affectedUsers.map((user) => () => ports.broadcast(user)),
      ...events.revoked.map(({ userId, driveId }) => () => ports.kick({ userId, driveId })),
    ],
    EVENT_CONCURRENCY,
  );
  const failures = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failures.length > 0) {
    const first: unknown = failures[0].reason;
    loggers.realtime.warn('Drive access events: some realtime events failed', {
      failures: failures.length,
      firstError: first instanceof Error ? first.message : String(first),
      affectedUsers: events.affectedUsers.length,
      revoked: events.revoked.length,
    });
  }
}

type DriveScope = { kind: 'org'; orgId: string } | { kind: 'drive'; driveId: string };

async function lockDrives(tx: Tx, scope: DriveScope): Promise<OrgSyncDrive[]> {
  const locked = await tx
    .select({ id: drives.id, ownerId: drives.ownerId, orgId: drives.orgId, orgVisibility: drives.orgVisibility })
    .from(drives)
    .where(scope.kind === 'org' ? eq(drives.orgId, scope.orgId) : eq(drives.id, scope.driveId))
    .orderBy(asc(drives.id))
    .for('update');
  if (locked.length === 0) return [];

  const defaultRoleByDrive = new Map<string, string>();
  for (const ids of chunk(locked.map((d) => d.id), WRITE_CHUNK)) {
    const roles = await tx
      .select({ id: driveRoles.id, driveId: driveRoles.driveId })
      .from(driveRoles)
      .where(and(inArray(driveRoles.driveId, ids), eq(driveRoles.isDefault, true)))
      .orderBy(asc(driveRoles.position), asc(driveRoles.id));
    for (const role of roles) {
      if (!defaultRoleByDrive.has(role.driveId)) defaultRoleByDrive.set(role.driveId, role.id);
    }
  }

  return locked.map((d) => ({ ...d, defaultCustomRoleId: defaultRoleByDrive.get(d.id) ?? null }));
}

async function loadOrgMemberIds(tx: Tx, orgId: string, userId?: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(userId ? and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)) : eq(orgMembers.orgId, orgId));
  return rows.map((r) => r.userId);
}

async function loadExistingRows(tx: Tx, driveIds: string[], userId?: string): Promise<ExistingDriveMemberRow[]> {
  const rows: ExistingDriveMemberRow[] = [];
  for (const ids of chunk(driveIds, WRITE_CHUNK)) {
    rows.push(
      ...(await tx
        .select({
          id: driveMembers.id,
          driveId: driveMembers.driveId,
          userId: driveMembers.userId,
          source: driveMembers.source,
          customRoleId: driveMembers.customRoleId,
          acceptedAt: driveMembers.acceptedAt,
        })
        .from(driveMembers)
        .where(userId ? and(inArray(driveMembers.driveId, ids), eq(driveMembers.userId, userId)) : inArray(driveMembers.driveId, ids))
      ).map(({ acceptedAt, ...row }) => ({ ...row, accepted: acceptedAt !== null })),
    );
  }
  return rows;
}

async function applyPlans(tx: Tx, plans: DriveOrgMembershipPlan[]): Promise<void> {
  const inserts = plans.flatMap((p) => p.inserts);
  const deletes = plans.flatMap((p) => p.deletes.map((d) => d.rowId));
  const conversions = plans.flatMap((p) => p.conversions.map((c) => c.rowId));
  const acceptedAt = new Date();

  for (const batch of chunk(inserts, WRITE_CHUNK)) {
    await tx
      .insert(driveMembers)
      .values(batch.map((i) => ({ driveId: i.driveId, userId: i.userId, role: 'MEMBER' as const, customRoleId: i.customRoleId, source: 'org' as const, acceptedAt })))
      .onConflictDoNothing({ target: [driveMembers.driveId, driveMembers.userId] });
  }
  for (const ids of chunk(deletes, WRITE_CHUNK)) {
    await tx.delete(driveMembers).where(and(inArray(driveMembers.id, ids), eq(driveMembers.source, 'org')));
  }
  for (const ids of chunk(conversions, WRITE_CHUNK)) {
    await tx.update(driveMembers).set({ source: 'invite' }).where(and(inArray(driveMembers.id, ids), eq(driveMembers.source, 'org')));
  }
  // One statement per row, since each carries its own drive's default role. Repairs are drift, not
  // bulk traffic.
  for (const repair of plans.flatMap((p): OrgRowUpdate[] => p.repairs)) {
    await tx
      .update(driveMembers)
      .set({ customRoleId: repair.customRoleId, acceptedAt: sql`coalesce(${driveMembers.acceptedAt}, (now() at time zone 'utc'))` })
      .where(and(eq(driveMembers.id, repair.rowId), eq(driveMembers.source, 'org')));
  }
}

async function runSync(
  options: OrgMembershipSyncOptions,
  plan: (tx: Tx) => Promise<DriveOrgMembershipPlan[]>,
): Promise<OrgMembershipSyncResult> {
  const execute = async (tx: Tx): Promise<OrgMembershipSyncResult> => {
    const plans = await plan(tx);
    await applyPlans(tx, plans);
    return {
      plans,
      affectedUsers: summarizeAffectedUsers(plans),
      removedRows: plans.flatMap((p) => p.deletes),
    };
  };

  if (options.tx) return execute(options.tx);

  const result = await db.transaction(execute);
  await publishOrgMembershipSyncEvents(result, options.ports);
  return result;
}

/** Bring every drive of an org in step with its members and visibility. */
export function syncOrgMembership(orgId: string, options: OrgMembershipSyncOptions = {}): Promise<OrgMembershipSyncResult> {
  return runSync(options, async (tx) => {
    const orgDrives = await lockDrives(tx, { kind: 'org', orgId });
    if (orgDrives.length === 0) return [];
    const memberIds = await loadOrgMemberIds(tx, orgId);
    const existingRows = await loadExistingRows(tx, orgDrives.map((d) => d.id));
    return orgDrives.map((drive) =>
      planDriveOrgMembership({ drive, orgMemberUserIds: memberIds, existingRows }),
    );
  });
}

/** Bring one user's rows across an org's drives in step: call after they join or leave the org. */
export function syncOrgMemberAccess(
  orgId: string,
  userId: string,
  options: OrgMembershipSyncOptions = {},
): Promise<OrgMembershipSyncResult> {
  return runSync(options, async (tx) => {
    const orgDrives = await lockDrives(tx, { kind: 'org', orgId });
    if (orgDrives.length === 0) return [];
    const memberIds = await loadOrgMemberIds(tx, orgId, userId);
    const existingRows = await loadExistingRows(tx, orgDrives.map((d) => d.id), userId);
    return orgDrives.map((drive) =>
      planDriveOrgMembership({
        drive,
        orgMemberUserIds: memberIds,
        existingRows,
        userScope: [userId],
      }),
    );
  });
}

/**
 * Bring one drive in step: call after its visibility changes or it moves into or out of an org.
 * After a move out (orgId now null) every org row goes; pass removedOrgRows 'keepAsInvite' to
 * keep those people as invited members instead (D-OW-10).
 */
export function syncDriveOrgMembership(driveId: string, options: DriveOrgMembershipSyncOptions = {}): Promise<OrgMembershipSyncResult> {
  return runSync(options, async (tx) => {
    const [drive] = await lockDrives(tx, { kind: 'drive', driveId });
    if (!drive) return [];
    const memberIds = drive.orgId ? await loadOrgMemberIds(tx, drive.orgId) : [];
    const existingRows = await loadExistingRows(tx, [drive.id]);
    return [planDriveOrgMembership({ drive, orgMemberUserIds: memberIds, existingRows, removedOrgRows: options.removedOrgRows })];
  });
}
