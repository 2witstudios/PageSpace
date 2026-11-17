import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNotNull, ne } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export interface LedDrive {
  id: string;
  sub: string | null;
  orgId: string | null;
  /**
   * An org drive someone else really is a member of: an ACCEPTED drive_members row with a
   * membership role. A pending invitation or a GUEST row (a redeemed page share link) is not
   * one. Always false for a personal drive, whose rows are never consulted.
   */
  sharedWithOthers: boolean;
}

/**
 * The drives `userId` leads (drives.ownerId), each marked with whether it is an org drive shared
 * with other members. Used by enforcement (parking a suspended account's published sites) to tell
 * a drive that is the user's alone from one other people rely on; it grants no access.
 *
 * Takes an executor so a caller inside a transaction reads what that transaction sees.
 */
export async function listLedDrivesWithSharing(userId: string, executor: Executor = db): Promise<LedDrive[]> {
  const led = await executor
    .select({ id: drives.id, sub: drives.publishSubdomain, orgId: drives.orgId })
    .from(drives)
    .where(eq(drives.ownerId, userId));

  const orgDriveIds = led.filter((d) => d.orgId !== null).map((d) => d.id);
  const shared = new Set<string>();
  if (orgDriveIds.length > 0) {
    const rows = await executor
      .selectDistinct({ driveId: driveMembers.driveId })
      .from(driveMembers)
      .where(
        and(
          inArray(driveMembers.driveId, orgDriveIds),
          ne(driveMembers.userId, userId),
          isNotNull(driveMembers.acceptedAt),
          ne(driveMembers.role, 'GUEST'),
        ),
      );
    for (const row of rows) shared.add(row.driveId);
  }

  return led.map((d) => ({ ...d, sharedWithOthers: shared.has(d.id) }));
}
