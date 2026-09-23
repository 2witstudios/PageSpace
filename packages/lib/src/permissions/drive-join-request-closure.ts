import type { db } from '@pagespace/db/db';
import { and, eq, inArray, sql } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveJoinRequests } from '@pagespace/db/schema/drive-join-requests';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { decideJoinRequestStaysOpen } from './drive-join-requests';

/**
 * Close the pending join requests on `driveIds` that no longer ask for anything
 * (decideJoinRequestStaysOpen): the drive left Restricted or its org, the requester left the org, or
 * they now lead the drive. Each is marked `withdrawn` with no decider, so the requester may ask
 * again, and nothing about them stays on an approver's list.
 *
 * Runs inside the transaction of the change that made the requests stale (a visibility or lead
 * change, a move out, a leave, org deletion), after that change's writes. A new request takes the
 * same drive lock (requestToJoinDrive), so none can slip in stale behind it.
 */
export async function closeStaleDriveJoinRequests(
  executor: Pick<typeof db, 'select' | 'update'>,
  driveIds: readonly string[],
): Promise<Array<{ id: string; driveId: string; userId: string }>> {
  const closed: Array<{ id: string; driveId: string; userId: string }> = [];
  for (const ids of chunks([...new Set(driveIds)])) {
    const pending = await executor
      .select({
        id: driveJoinRequests.id,
        driveId: driveJoinRequests.driveId,
        userId: driveJoinRequests.userId,
        ownerId: drives.ownerId,
        orgId: drives.orgId,
        orgVisibility: drives.orgVisibility,
        requesterOrgRole: orgMembers.role,
      })
      .from(driveJoinRequests)
      .innerJoin(drives, eq(drives.id, driveJoinRequests.driveId))
      .leftJoin(orgMembers, and(eq(orgMembers.orgId, drives.orgId), eq(orgMembers.userId, driveJoinRequests.userId)))
      .where(and(inArray(driveJoinRequests.driveId, ids), eq(driveJoinRequests.status, 'pending')));

    const stale = pending
      .filter((r) => !decideJoinRequestStaysOpen({ drive: r, requesterId: r.userId, requesterOrgRole: r.requesterOrgRole }))
      .map((r) => r.id);
    if (stale.length === 0) continue;

    closed.push(...await executor
      .update(driveJoinRequests)
      .set({ status: 'withdrawn', decidedAt: sql`(now() at time zone 'utc')` })
      .where(and(inArray(driveJoinRequests.id, stale), eq(driveJoinRequests.status, 'pending')))
      .returning({ id: driveJoinRequests.id, driveId: driveJoinRequests.driveId, userId: driveJoinRequests.userId }));
  }
  return closed;
}

/** Chunk size for id IN lists (Postgres bind parameter limit). */
const IN_LIST_CHUNK = 500;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_LIST_CHUNK) out.push(items.slice(i, i + IN_LIST_CHUNK));
  return out;
}
