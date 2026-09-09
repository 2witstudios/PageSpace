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
import { eq, ne, and, or, inArray, isNotNull, ilike, exists, sql } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers, userProfiles } from '@pagespace/db/schema/members';
import { users } from '@pagespace/db/schema/auth';
import { connections } from '@pagespace/db/schema/social';
import type { PublicProfileRow } from './enumeration-safe';

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
 * Name-match verified user profiles the caller already shares context with —
 * accepted connections (either direction) and accepted co-members/owners of any
 * drive the caller owns or is an accepted member of — regardless of the profile's
 * `isPublic` flag. Excludes the caller themselves and temp/magic-link accounts
 * (emailVerified IS NULL). `usernamePattern` must already be a LIKE-escaped
 * `%…%` pattern.
 *
 * This is the search counterpart of {@link callerCanViewUser}: it lets an
 * already-known person surface by name even when their profile is private — you
 * can only find, by name, someone you already have a relationship with, so it
 * opens no new enumeration surface. Same `acceptedAt` gate applies: a pending,
 * unaccepted invite is not an established relationship.
 *
 * The relationship is expressed as correlated EXISTS subqueries against
 * userProfiles rather than by materializing every collaborator id in the app and
 * expanding it into an IN list: the name predicate and LIMIT are applied inside
 * the database, so cost scales with the number of MATCHES (bounded by `limit`),
 * not with the total membership of the caller's drives. The only set carried in
 * memory is the caller's own drive ids, which is inherently bounded.
 */
export async function searchRelatedProfilesByName(
  callerId: string,
  usernamePattern: string,
  limit: number,
): Promise<PublicProfileRow[]> {
  const callerDriveIds = await getUserDriveIds(callerId);

  // Accepted connection with the caller, either direction.
  const connectedToCaller = exists(
    db
      .select({ one: sql`1` })
      .from(connections)
      .where(
        and(
          eq(connections.status, 'ACCEPTED'),
          or(
            and(eq(connections.user1Id, callerId), eq(connections.user2Id, userProfiles.userId)),
            and(eq(connections.user2Id, callerId), eq(connections.user1Id, userProfiles.userId)),
          ),
        ),
      ),
  );

  const relationshipPredicates = [connectedToCaller];
  if (callerDriveIds.length > 0) {
    // Accepted member of one of the caller's drives.
    relationshipPredicates.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(driveMembers)
          .where(
            and(
              eq(driveMembers.userId, userProfiles.userId),
              isNotNull(driveMembers.acceptedAt),
              inArray(driveMembers.driveId, callerDriveIds),
            ),
          ),
      ),
    );
    // Owner of one of the caller's drives.
    relationshipPredicates.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(drives)
          .where(and(eq(drives.ownerId, userProfiles.userId), inArray(drives.id, callerDriveIds))),
      ),
    );
  }

  return db
    .select({
      userId: userProfiles.userId,
      username: userProfiles.username,
      displayName: userProfiles.displayName,
      bio: userProfiles.bio,
      avatarUrl: userProfiles.avatarUrl,
    })
    .from(userProfiles)
    .innerJoin(users, eq(userProfiles.userId, users.id))
    .where(
      and(
        ne(userProfiles.userId, callerId),
        isNotNull(users.emailVerified),
        or(ilike(userProfiles.username, usernamePattern), ilike(userProfiles.displayName, usernamePattern)),
        or(...relationshipPredicates),
      ),
    )
    .limit(limit);
}
