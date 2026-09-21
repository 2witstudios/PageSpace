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

export type DriveLeadAuthority =
  | { allowed: false }
  | { allowed: true; via: 'lead' }
  | { allowed: true; via: 'org-owner' | 'org-admin'; orgId: string };

export interface DriveLeadAuthorityInput {
  orgsEnabled: boolean;
  userId: string;
  drive: { ownerId: string | null | undefined; orgId: string | null };
  /** The user's role in drive.orgId; null when not a member or the drive has no org. */
  orgRole: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
}

/**
 * Who may take a lead-only action on a drive (rename, restore, permanent deletion). On a personal
 * drive: its owner only. On an org-owned drive: its lead, and also an org Owner or Admin (ORG-4:
 * full access on every org-owned drive; DRV-1: the human lead keeps the Owner role). The org-power
 * answers name themselves so the caller writes the audit event.
 */
export function decideDriveLeadAuthority({ orgsEnabled, userId, drive, orgRole }: DriveLeadAuthorityInput): DriveLeadAuthority {
  if (isDriveLead(userId, drive)) return { allowed: true, via: 'lead' };
  if (!orgsEnabled || drive.orgId === null) return { allowed: false };
  if (orgRole === 'OWNER') return { allowed: true, via: 'org-owner', orgId: drive.orgId };
  if (orgRole === 'ADMIN') return { allowed: true, via: 'org-admin', orgId: drive.orgId };
  return { allowed: false };
}
