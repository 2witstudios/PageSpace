/**
 * The per-drive Imago setting (IMG-4.6, IMG-4.6a; reshaped by IMG-10.10).
 *
 * Imago acts with its owner's own reach (`imago-reach.ts`), so the setting is
 * no longer a grant but the user's exclusion: off keeps Imago out of that
 * drive for that user — every page, tool, integration and search result in it
 * — even though the user can open it; on (the default, with nothing stored)
 * lets it work there. The choice is the viewer's own and touches nobody
 * else's Imago, so any user who can access the drive may read and set it, not
 * only owners and admins. It is stored in `imago_drive_access` under the
 * user-row lock provisioning takes, and outlives the agent page.
 *
 * The viewer's own Home drive is refused: Imago lives there.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { getUserDriveAccess } from '../permissions/permissions';
import type { ServiceFailure } from '../services/drive-agent-service';
import { homeDriveActionError } from '../services/drive-guards';
import { imagoExcludedDriveIds, lockImagoUser, storeImagoDriveChoice } from './imago-reach';

export interface ImagoDriveAccess {
  driveId: string;
  /** Whether Imago may work in the drive for the viewer: false once they keep it out. */
  enabled: boolean;
}

export type ImagoDriveAccessResult = { ok: true; access: ImagoDriveAccess } | ServiceFailure;

const FORBIDDEN: ServiceFailure = {
  ok: false,
  status: 403,
  error: 'You can only set Imago access for a drive you can access',
};

/** Read whether Imago may work in a drive for the viewer. */
export async function getImagoDriveAccess(userId: string, driveId: string): Promise<ImagoDriveAccessResult> {
  if (!(await getUserDriveAccess(userId, driveId))) return FORBIDDEN;
  return { ok: true, access: await readAccess(userId, driveId) };
}

/** Let Imago into a drive for the viewer, or keep it out; returns the new state. */
export async function setImagoDriveAccess(
  userId: string,
  driveId: string,
  enabled: boolean,
): Promise<ImagoDriveAccessResult> {
  if (!(await getUserDriveAccess(userId, driveId))) return FORBIDDEN;

  const [drive] = await db
    .select({ kind: drives.kind, ownerId: drives.ownerId })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);
  if (!drive) return FORBIDDEN;
  const homeError = drive.ownerId === userId ? homeDriveActionError(drive, 'imago-access') : null;
  if (homeError) return { ok: false, status: 403, error: homeError };

  await db.transaction(async (tx) => {
    await lockImagoUser(tx, userId);
    await storeImagoDriveChoice(tx, userId, driveId, enabled);
  });
  return { ok: true, access: await readAccess(userId, driveId) };
}

async function readAccess(userId: string, driveId: string): Promise<ImagoDriveAccess> {
  const excluded = await imagoExcludedDriveIds(userId, [driveId]);
  return { driveId, enabled: !excluded.has(driveId) };
}
