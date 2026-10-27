import type { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { organizations } from '@pagespace/db/schema/organizations';
import type { ClaimedGuestApproval } from './guest-holds';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A committed org decision authorizes its original drive only while that drive
 * still belongs to the org. Org before drive matches moves and deletion; SHARE
 * blocks either row changing until the admission's transaction commits.
 */
export async function lockApprovedGuestDriveScope(
  tx: Tx,
  scope: Pick<ClaimedGuestApproval, 'orgId' | 'driveId'>,
): Promise<boolean> {
  const [org] = await tx.select({ id: organizations.id }).from(organizations)
    .where(eq(organizations.id, scope.orgId)).for('share');
  if (!org) return false;
  const [drive] = await tx.select({ orgId: drives.orgId }).from(drives)
    .where(eq(drives.id, scope.driveId)).for('share');
  return drive?.orgId === scope.orgId;
}
