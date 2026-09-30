/**
 * Guest suspension (Spec POL-1, POL-2): when an org sets guests to off, the guests already in its drives
 * are SUSPENDED, never removed, and turning the policy back on restores exactly those rows.
 *
 * Lives in permissions/ because it reads and writes drive_members and decides who counts as a guest;
 * the drive-access-gates seam allows that only here. A guest of an org drive is a drive_members row
 * whose user is not an org member (DRV-8), which includes the GUEST rows a page share link creates
 * (D-OW-24). The drive's lead is never a guest, even if a legacy lead is outside the org.
 *
 * Suspension is a marker (`suspendedByPolicy = 'guests'`); the row, its role and its page permissions
 * are untouched, so nothing is destroyed and restore clears only what this set.
 */
import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNull, sql } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { orgMembers } from '@pagespace/db/schema/organizations';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export interface SuspendedGuest {
  memberRowId: string;
  driveId: string;
  userId: string;
}

const orgDriveIds = (executor: Executor, orgId: string) =>
  executor.select({ id: drives.id }).from(drives).where(eq(drives.orgId, orgId));

/** Rows of `orgId`'s drives held by someone outside the org who does not lead the drive. */
const guestRowsOf = (executor: Executor, orgId: string) =>
  and(
    inArray(driveMembers.driveId, orgDriveIds(executor, orgId)),
    sql`not exists (select 1 from ${orgMembers} where ${orgMembers.orgId} = ${orgId} and ${orgMembers.userId} = ${driveMembers.userId})`,
    sql`not exists (select 1 from ${drives} d where d.id = ${driveMembers.driveId} and d."ownerId" = ${driveMembers.userId})`,
  );

/** Mark every in-force guest row of the org's drives suspended. Idempotent. */
export async function suspendOrgGuests(executor: Executor, orgId: string): Promise<SuspendedGuest[]> {
  const rows = await executor
    .update(driveMembers)
    .set({ suspendedByPolicy: 'guests' })
    .where(and(isNull(driveMembers.suspendedByPolicy), guestRowsOf(executor, orgId)))
    .returning({ memberRowId: driveMembers.id, driveId: driveMembers.driveId, userId: driveMembers.userId });
  return rows;
}

/** Clear the marker on exactly the rows the guests policy suspended. Idempotent. */
export async function restoreOrgGuests(executor: Executor, orgId: string): Promise<SuspendedGuest[]> {
  const rows = await executor
    .update(driveMembers)
    .set({ suspendedByPolicy: null })
    .where(and(eq(driveMembers.suspendedByPolicy, 'guests'), inArray(driveMembers.driveId, orgDriveIds(executor, orgId))))
    .returning({ memberRowId: driveMembers.id, driveId: driveMembers.driveId, userId: driveMembers.userId });
  return rows;
}

export interface SuspendedGuestPage {
  total: number;
  items: SuspendedGuest[];
}

/** The org's suspended guests, bounded: `total` is the full count, `items` at most `limit`. */
export async function listSuspendedOrgGuests(orgId: string, limit: number, executor: Executor = db): Promise<SuspendedGuestPage> {
  const where = and(eq(driveMembers.suspendedByPolicy, 'guests'), inArray(driveMembers.driveId, orgDriveIds(executor, orgId)));
  const [items, [counted]] = await Promise.all([
    executor
      .select({ memberRowId: driveMembers.id, driveId: driveMembers.driveId, userId: driveMembers.userId })
      .from(driveMembers)
      .where(where)
      .orderBy(driveMembers.id)
      .limit(limit),
    executor.select({ total: sql<number>`count(*)::int` }).from(driveMembers).where(where),
  ]);
  return { total: counted?.total ?? 0, items };
}
