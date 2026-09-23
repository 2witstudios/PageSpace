import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { isDriveMemberRelationship } from './drive-relationship';
import { loadDriveRelationships } from './drive-relationship-loader';

/**
 * A person's standing in the drive an AI call runs in, for the wallet-aware credit gate
 * (SPEND-1, DRV-8): the drive's org and owner, whether they are an effective member of the
 * drive (the one org-aware access model), and whether they hold a seat in its org (an
 * accepted org member). A pending, unaccepted invite grants nothing: org_members rows exist
 * only for accepted members, and the drive membership model counts accepted rows only.
 *
 * Null when the drive does not exist. Never throws on a non-member: that is an answer
 * (`isDriveMember: false`), and the gate treats it as a guest.
 */
export interface DriveSpendStanding {
  driveId: string;
  orgId: string | null;
  /** The drive's lead, whose personal wallet parents a personal drive's wallet (WAL-2). */
  ownerId: string;
  isDriveMember: boolean;
  isOrgMember: boolean;
}

export async function loadDriveSpendStanding(userId: string, driveId: string): Promise<DriveSpendStanding | null> {
  const [drive] = await db
    .select({ id: drives.id, ownerId: drives.ownerId, orgId: drives.orgId, orgVisibility: drives.orgVisibility })
    .from(drives)
    .where(eq(drives.id, driveId))
    .limit(1);
  if (!drive) return null;

  // The gate reads this for the caller's own request, whose drive access was already
  // decided (and audited) by the route; this read only classifies the spender.
  const relationships = await loadDriveRelationships(userId, [drive], { audit: false });
  const relationship = relationships.get(drive.id);
  const isDriveMember = relationship ? isDriveMemberRelationship(relationship) : false;

  let isOrgMember = false;
  if (drive.orgId !== null) {
    const [membership] = await db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, drive.orgId), eq(orgMembers.userId, userId)))
      .limit(1);
    isOrgMember = membership !== undefined;
  }

  return { driveId: drive.id, orgId: drive.orgId, ownerId: drive.ownerId, isDriveMember, isOrgMember };
}
