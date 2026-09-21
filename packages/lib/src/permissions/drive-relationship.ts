import { db } from '@pagespace/db/db';
import type { OrgDriveVisibility } from '@pagespace/db/schema/core';
import {
  loadAcceptedRowsInDrives,
  loadEffectiveDriveMembership,
  resolveEffectiveDriveMemberships,
  type ResolveMembershipsOptions,
} from './org-drive-membership';
import type { EffectiveDriveMembership } from './org-drive-resolution';
import type { DriveMemberRole } from './org-access';

/**
 * A person's relationship to one drive, as every access gate outside this directory asks it: are
 * they the drive's lead (drives.ownerId), and what is their effective membership (the org-aware
 * model: accepted rows only, org Owner/Admin power, implicit Open membership, stale org rows and
 * former-lead OWNER rows counting for nothing). The gates keep their own role test (owner or ADMIN,
 * owner or OWNER/ADMIN row, any member) on the answer, so a personal drive answers exactly as the
 * inline owner-then-row checks did.
 */

/**
 * The drive facts a relationship depends on. All four are required: a caller that selected only
 * `{ id, ownerId }` would otherwise be read as a personal drive and skip the org model.
 */
export interface RelationshipDrive {
  id: string;
  ownerId: string;
  orgId: string | null;
  orgVisibility: OrgDriveVisibility;
}

export interface DriveRelationship {
  /** The drive's lead (drives.ownerId). */
  isOwner: boolean;
  /** The effective membership of a non-lead; null for the lead (never read) and for a non-member. */
  membership: EffectiveDriveMembership | null;
}

/**
 * Whether `userId` leads the drive (drives.ownerId). The one place a drive's ownerId is compared to a
 * person: lead-only actions (restore, rename, ownership transfer) ask this and nothing else.
 */
export function isDriveLead(userId: string, drive: { ownerId: string | null | undefined }): boolean {
  return typeof drive.ownerId === 'string' && drive.ownerId === userId;
}

/** OWNER for the lead, else the effective membership's role, else null. */
export function driveRoleOf(relationship: DriveRelationship): DriveMemberRole | null {
  return relationship.isOwner ? 'OWNER' : relationship.membership?.role ?? null;
}

/** The lead or an effective ADMIN: the isDriveOwnerOrAdmin answer. */
export function canAdministerDrive(relationship: DriveRelationship): boolean {
  return relationship.isOwner || relationship.membership?.role === 'ADMIN';
}

/** The lead or any effective member: the isUserDriveMember answer. */
export function isDriveMemberRelationship(relationship: DriveRelationship): boolean {
  return relationship.isOwner || relationship.membership !== null;
}

const LEAD: DriveRelationship = { isOwner: true, membership: null };

export async function loadDriveRelationship(userId: string, drive: RelationshipDrive): Promise<DriveRelationship> {
  if (isDriveLead(userId, drive)) return LEAD;
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
  for (const drive of driveList) if (isDriveLead(userId, drive)) out.set(drive.id, LEAD);
  if (notLed.length === 0) return out;

  const rows = await loadAcceptedRowsInDrives(db, userId, notLed.map((drive) => drive.id));
  const effective = await resolveEffectiveDriveMemberships(
    notLed.map((drive) => ({ userId, drive, row: rows.get(drive.id) ?? null })),
    options,
  );
  notLed.forEach((drive, i) => out.set(drive.id, { isOwner: false, membership: effective[i] }));
  return out;
}
