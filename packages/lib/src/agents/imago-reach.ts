/**
 * Imago's reach (owner decision 2026-10-06; IMG-10.10).
 *
 * Imago replaces the Global Assistant one for one, so it acts with its owner's
 * own reach — `pages.userScopedAccess` on the agent page, resolved by
 * `actor-permissions.ts` in apps/web — and never through `drive_agent_members`
 * grants. The one thing the owner can take away is a drive: a stored
 * `imago_drive_access` row with `enabled = false` keeps Imago out of that
 * drive for that user, even though the user can open it. With no row, or a row
 * that is on, Imago may work there. Each user sets only their own rows, in any
 * drive they can access (`imago-drive-access.ts`).
 *
 * The grants the earlier model created (IMG-4.5/4.6) are moot, so provisioning
 * removes them (`removeImagoDriveGrants`) and nothing creates them any more.
 *
 * Race safety: provisioning and the per-drive setting both take the user-row
 * lock (`lockImagoUser`), so a setting stored while a sign-in provisions is
 * never lost — and reads of the exclusion set need no lock: a row is the
 * user's latest choice the moment it commits.
 */

import { db } from '@pagespace/db/db';
import { and, eq, inArray, ne, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { pages } from '@pagespace/db/schema/core';
import { imagoDriveAccess } from '@pagespace/db/schema/imago-drive-access';
import { driveAgentMembers } from '@pagespace/db/schema/members';

/** A Drizzle transaction handle, accepted alongside the module-level `db`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Take the user-row lock that serialises Imago provisioning and the per-drive
 * setting for one user. Inside an open transaction only; held until it ends.
 */
export async function lockImagoUser(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} FOR UPDATE`);
}

/**
 * The drives the user keeps Imago out of — among `driveIds` when given. A
 * state read, not a permission check: Imago's reach is still capped by the
 * user's own access everywhere else.
 */
export async function imagoExcludedDriveIds(
  userId: string,
  driveIds?: readonly string[],
  executor: Tx | typeof db = db,
): Promise<Set<string>> {
  if (driveIds?.length === 0) return new Set();
  const rows = await executor
    .select({ driveId: imagoDriveAccess.driveId })
    .from(imagoDriveAccess)
    .where(and(
      eq(imagoDriveAccess.userId, userId),
      eq(imagoDriveAccess.enabled, false),
      driveIds ? inArray(imagoDriveAccess.driveId, [...driveIds]) : undefined,
    ));
  return new Set(rows.map((row) => row.driveId));
}

/**
 * Store the user's Imago choice for a drive. Inside the caller's transaction,
 * which should hold `lockImagoUser`.
 */
export async function storeImagoDriveChoice(
  executor: Tx | typeof db,
  userId: string,
  driveId: string,
  enabled: boolean,
): Promise<void> {
  const now = new Date();
  await executor
    .insert(imagoDriveAccess)
    .values({ userId, driveId, enabled, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [imagoDriveAccess.userId, imagoDriveAccess.driveId],
      set: { enabled, updatedAt: now },
    });
}

/**
 * Remove every membership of `pageIds` outside the drive each page lives in —
 * the drive grants the earlier Imago model made. The agent's own Home
 * membership stays. Returns how many rows were removed; idempotent.
 */
export async function removeImagoDriveGrants(
  executor: Tx | typeof db,
  pageIds: readonly string[],
): Promise<number> {
  if (pageIds.length === 0) return 0;
  const rows = await executor
    .select({ id: driveAgentMembers.id })
    .from(driveAgentMembers)
    .innerJoin(pages, eq(pages.id, driveAgentMembers.agentPageId))
    .where(and(inArray(driveAgentMembers.agentPageId, [...pageIds]), ne(pages.driveId, driveAgentMembers.driveId)));
  if (rows.length === 0) return 0;
  await executor.delete(driveAgentMembers).where(inArray(driveAgentMembers.id, rows.map((row) => row.id)));
  return rows.length;
}
