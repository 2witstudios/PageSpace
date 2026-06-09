/**
 * Relationship-scoping for user lookups (security audit finding L1).
 *
 * Decides whether `callerId` is already allowed to see `targetId` — i.e. they
 * share a drive (as owner or member) or have an accepted connection. The
 * `/api/users/find` handler uses this so it can only surface a user's identity
 * to callers who already have a relationship, collapsing every other outcome
 * into a uniform not-found (see `resolveFindUser`).
 */

import { db } from '@pagespace/db/db';
import { eq, and, or, inArray } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { connections } from '@pagespace/db/schema/social';

/** Drive ids the user owns or is a member of. */
async function getUserDriveIds(userId: string): Promise<string[]> {
  const [owned, member] = await Promise.all([
    db.select({ id: drives.id }).from(drives).where(eq(drives.ownerId, userId)),
    db
      .select({ driveId: driveMembers.driveId })
      .from(driveMembers)
      .where(eq(driveMembers.userId, userId)),
  ]);
  return Array.from(
    new Set<string>([...owned.map((d) => d.id), ...member.map((m) => m.driveId)]),
  );
}

/**
 * True when the caller already shares context with the target: themselves, an
 * accepted connection (either direction), or co-membership of any drive.
 */
export async function callerCanViewUser(
  callerId: string,
  targetId: string,
): Promise<boolean> {
  if (callerId === targetId) return true;

  const acceptedConnection = await db
    .select({ status: connections.status })
    .from(connections)
    .where(
      and(
        eq(connections.status, 'ACCEPTED'),
        or(
          and(eq(connections.user1Id, callerId), eq(connections.user2Id, targetId)),
          and(eq(connections.user1Id, targetId), eq(connections.user2Id, callerId)),
        ),
      ),
    )
    .limit(1);
  if (acceptedConnection.length > 0) return true;

  const callerDriveIds = await getUserDriveIds(callerId);
  if (callerDriveIds.length === 0) return false;

  const sharedMembership = await db
    .select({ driveId: driveMembers.driveId })
    .from(driveMembers)
    .where(
      and(eq(driveMembers.userId, targetId), inArray(driveMembers.driveId, callerDriveIds)),
    )
    .limit(1);
  if (sharedMembership.length > 0) return true;

  const sharedOwnership = await db
    .select({ id: drives.id })
    .from(drives)
    .where(and(eq(drives.ownerId, targetId), inArray(drives.id, callerDriveIds)))
    .limit(1);
  return sharedOwnership.length > 0;
}
