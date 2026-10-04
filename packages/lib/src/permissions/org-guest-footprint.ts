import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

/**
 * Is this person a GUEST of the org (DRV-8, D-OW-24)? For someone who is not an org member, any
 * drive_members row on one of the org's drives (accepted or pending, any role) makes them a guest, as
 * does a guest hold the org queued or parked for them. The caller asks only about non-members.
 *
 * Read by verified-domain auto-join (SEC-1): a guest is never turned into a member by their address.
 */
export async function isOrgGuest(orgId: string, userId: string, executor: Executor = db): Promise<boolean> {
  const [row] = await executor
    .select({ id: driveMembers.id })
    .from(driveMembers)
    .innerJoin(drives, eq(drives.id, driveMembers.driveId))
    .where(and(eq(drives.orgId, orgId), eq(driveMembers.userId, userId)))
    .limit(1);
  if (row) return true;
  const [hold] = await executor
    .select({ id: orgGuestHolds.id })
    .from(orgGuestHolds)
    .where(and(eq(orgGuestHolds.orgId, orgId), eq(orgGuestHolds.userId, userId)))
    .limit(1);
  return hold !== undefined;
}
