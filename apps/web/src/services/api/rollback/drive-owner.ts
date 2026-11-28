/**
 * Drive owner changes during rollback and redo.
 *
 * An `ownership_transfer` activity records the owner before and after. Undoing
 * or redoing it changes the owner again, so it goes through the same helper as
 * the transfer route — `transferDriveOwnership` — which refuses Home drives and
 * revokes the outgoing owner's Imago agent grants in the same transaction
 * (Imago plan, DEC-2). Writing `ownerId` directly would leave the outgoing
 * owner's Imago agents inside a drive they no longer own.
 */
import { eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { transferDriveOwnership } from '@pagespace/lib/services/drive-service';
import type { RollbackDeps } from './deps';

/**
 * Apply the `ownerId` in `updateData` (if any) through `transferDriveOwnership`
 * on `deps.db`, and return the remaining fields for the plain drive update.
 */
export async function applyDriveOwnerChange(
  deps: RollbackDeps,
  driveId: string,
  updateData: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { ownerId, ...rest } = updateData;
  if (ownerId === undefined) return updateData;
  if (typeof ownerId !== 'string') throw new Error('Invalid ownerId to restore');

  const [drive] = await deps.db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, driveId)).limit(1);
  if (!drive) throw new Error('Drive not found');
  if (drive.ownerId !== ownerId) await transferDriveOwnership(driveId, drive.ownerId, ownerId, deps.db);
  return rest;
}
