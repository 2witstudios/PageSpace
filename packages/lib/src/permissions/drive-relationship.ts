import type { OrgDriveVisibility } from '@pagespace/db/schema/core';
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
