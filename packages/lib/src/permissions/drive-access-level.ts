/**
 * Canonical "what is this user's relationship to this drive" lookup.
 *
 * This is the single source of truth for the isOwner/isAdmin/isMember
 * question against `driveMembers` — every caller that needs it (member
 * management, role management, AI tools, bulk page ops, ...) should resolve
 * through here rather than re-querying `driveMembers` inline. Before this was
 * centralized, `drive-role-service.ts`'s `checkDriveAccessForRoles` carried
 * its own copy of this query and had silently drifted: it was missing the
 * `isNotNull(driveMembers.acceptedAt)` gate that this version enforces,
 * which would have let a pending (unaccepted) admin invite pass role-management
 * authorization checks.
 */
import { db } from '@pagespace/db/db';
import { eq, and, isNotNull } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';

export interface DriveAccessLevel {
  isOwner: boolean;
  isAdmin: boolean;
  isMember: boolean;
  drive: typeof drives.$inferSelect | null;
}

export async function getDriveAccessLevel(
  driveId: string,
  userId: string
): Promise<DriveAccessLevel> {
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
  });

  if (!drive) {
    return { isOwner: false, isAdmin: false, isMember: false, drive: null };
  }

  const isOwner = drive.ownerId === userId;

  if (isOwner) {
    return { isOwner: true, isAdmin: true, isMember: true, drive };
  }

  const membership = await db
    .select({ role: driveMembers.role })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.driveId, driveId),
      eq(driveMembers.userId, userId),
      isNotNull(driveMembers.acceptedAt),
    ))
    .limit(1);

  if (membership.length === 0) {
    return { isOwner: false, isAdmin: false, isMember: false, drive };
  }

  const role = membership[0].role;
  return {
    isOwner: false,
    isAdmin: role === 'ADMIN',
    isMember: true,
    drive,
  };
}
