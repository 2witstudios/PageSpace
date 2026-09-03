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
import { eq, and, or, inArray, isNotNull } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { connections } from '@pagespace/db/schema/social';

/**
 * Drive ids the user owns or is an ACCEPTED member of.
 *
 * `driveMembers` reads used for an authorization decision must gate on
 * `isNotNull(acceptedAt)` (repo convention — see drive-member-gate-coverage):
 * a pending, unaccepted invitation is not an established shared context, so it
 * must not let the invitee resolve other members' identities (nor vice versa).
 */
async function getUserDriveIds(userId: string): Promise<string[]> {
  const [owned, member] = await Promise.all([
    db.select({ id: drives.id }).from(drives).where(eq(drives.ownerId, userId)),
    db
      .select({ driveId: driveMembers.driveId })
      .from(driveMembers)
      .where(and(eq(driveMembers.userId, userId), isNotNull(driveMembers.acceptedAt))),
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
      and(
        eq(driveMembers.userId, targetId),
        inArray(driveMembers.driveId, callerDriveIds),
        isNotNull(driveMembers.acceptedAt),
      ),
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

/**
 * The set of users the caller already shares context with: accepted connections
 * (either direction) and co-members/owners of any drive the caller owns or is an
 * accepted member of. Excludes the caller themselves.
 *
 * This is the set form of {@link callerCanViewUser}. The search endpoint uses it
 * to let already-known people surface by name even when their profile is private
 * — you can only find, by name, someone you already have a relationship with, so
 * it opens no new enumeration surface. Same `acceptedAt` gate applies: a pending,
 * unaccepted invite is not an established relationship.
 */
export async function getRelatedUserIds(callerId: string): Promise<string[]> {
  const related = new Set<string>();

  // Accepted connections and the caller's own drive ids are independent lookups;
  // run them together to keep this off the critical path of a per-keystroke
  // typeahead search.
  const [acceptedConnections, callerDriveIds] = await Promise.all([
    db
      .select({ user1Id: connections.user1Id, user2Id: connections.user2Id })
      .from(connections)
      .where(
        and(
          eq(connections.status, 'ACCEPTED'),
          or(eq(connections.user1Id, callerId), eq(connections.user2Id, callerId)),
        ),
      ),
    getUserDriveIds(callerId),
  ]);
  for (const row of acceptedConnections) {
    related.add(row.user1Id === callerId ? row.user2Id : row.user1Id);
  }

  if (callerDriveIds.length > 0) {
    const [coMembers, owners] = await Promise.all([
      db
        .select({ userId: driveMembers.userId })
        .from(driveMembers)
        .where(
          and(
            inArray(driveMembers.driveId, callerDriveIds),
            isNotNull(driveMembers.acceptedAt),
          ),
        ),
      db
        .select({ ownerId: drives.ownerId })
        .from(drives)
        .where(inArray(drives.id, callerDriveIds)),
    ]);
    for (const row of coMembers) related.add(row.userId);
    for (const row of owners) related.add(row.ownerId);
  }

  related.delete(callerId);
  return Array.from(related);
}
