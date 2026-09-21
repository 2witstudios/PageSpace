import { db } from '@pagespace/db/db';
import {
  loadAcceptedRowsInDrives,
  loadEffectiveDriveMembership,
  resolveEffectiveDriveMemberships,
  type ResolveMembershipsOptions,
} from './org-drive-membership';
import { isDriveLead, type DriveRelationship, type RelationshipDrive } from './drive-relationship';

/** The IO around the drive relationship decisions in drive-relationship.ts. */

export const LEAD_RELATIONSHIP: DriveRelationship = { isOwner: true, membership: null };

export async function loadDriveRelationship(userId: string, drive: RelationshipDrive): Promise<DriveRelationship> {
  if (isDriveLead(userId, drive)) return LEAD_RELATIONSHIP;
  return { isOwner: false, membership: await loadEffectiveDriveMembership(userId, drive) };
}

/**
 * loadDriveRelationship for many drives at once, keyed by drive id: one accepted-rows query plus the
 * shared resolver's (at most two) org queries, however many drives.
 */
export async function loadDriveRelationships(
  userId: string,
  driveList: RelationshipDrive[],
  options: ResolveMembershipsOptions = { audit: true },
): Promise<Map<string, DriveRelationship>> {
  const out = new Map<string, DriveRelationship>();
  const notLed = driveList.filter((drive) => !isDriveLead(userId, drive));
  for (const drive of driveList) if (isDriveLead(userId, drive)) out.set(drive.id, LEAD_RELATIONSHIP);
  if (notLed.length === 0) return out;

  const rows = await loadAcceptedRowsInDrives(db, userId, notLed.map((drive) => drive.id));
  const effective = await resolveEffectiveDriveMemberships(
    notLed.map((drive) => ({ userId, drive, row: rows.get(drive.id) ?? null })),
    options,
  );
  notLed.forEach((drive, i) => out.set(drive.id, { isOwner: false, membership: effective[i] }));
  return out;
}
