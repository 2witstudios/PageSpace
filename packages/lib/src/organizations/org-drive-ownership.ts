import type { OrgRole } from '@pagespace/db/schema/organizations';
import type { OrgDriveVisibility } from '@pagespace/db/schema/core';
import { homeDriveActionError, isHomeDrive } from '../services/drive-guards';

/**
 * Org-owned drives: who may move a drive into or out of an org, who may create one
 * in an org, and who may lead one (Spec DRV-1..DRV-4, O-7, O-10).
 *
 * Pure decisions over facts the service fetches (the drive row and the actor's org
 * role). No IO. The service in org-drive-service.ts runs them inside the transaction that
 * writes drives.orgId.
 *
 * - Move in: the drive's owner only, who must be a member of the target org (the lead of an
 *   org drive is always an org member, O-7). Home never moves (drive-guards).
 * - Move out: an org Owner or Admin, with an explicit keep-or-remove choice for the
 *   org-sourced members (D-OW-10). No default: the choice must be visible.
 * - Refusal order discloses nothing to an outsider: ownership (move in) and org authority
 *   (move out) are checked before any fact about the drive itself.
 * - Create in org: an org member, subject to the "who can create org drives" policy
 *   (POL-5), which Wave E owns; the service passes the policy through a seam.
 */

/** Board leaf that owns storage re-attribution on move (O-9, D-OW-9). */
export const STORAGE_REATTRIBUTION_LEAF_ID = 't1759m6mfxrj5hyaleu1mdqs';
/** Board leaf that owns the "who can create org drives" policy (POL-5). */
export const ORG_DRIVE_CREATION_POLICY_LEAF_ID = 'lyt8275djmdcwlwm8wvk2xa5';

export type OrgDriveRefusalCode =
  | 'HOME_DRIVE'
  | 'NOT_DRIVE_OWNER'
  | 'NOT_ORG_MEMBER'
  | 'ALREADY_IN_ORG'
  | 'DRIVE_TRASHED'
  | 'NOT_IN_ORG'
  | 'NOT_ORG_ADMIN'
  | 'IMPLICIT_MEMBERS_CHOICE_REQUIRED'
  | 'POLICY_FORBIDS_CREATE';

export interface OrgDriveRefusal {
  ok: false;
  code: OrgDriveRefusalCode;
  status: 400 | 403 | 409;
  message: string;
}

/**
 * What happens to org-sourced drive members when a drive leaves its org (D-OW-10):
 * `keep` converts them to invited members, `remove` revokes them.
 */
export type ImplicitMembersChoice = 'keep' | 'remove';

/** "Who can create org drives" (POL-5). */
export type OrgDriveCreationPolicy = 'members' | 'admins';

export interface MoveInDrive {
  kind: string | null;
  ownerId: string;
  orgId: string | null;
  isTrashed: boolean;
}

const refuse = (
  code: OrgDriveRefusalCode,
  status: OrgDriveRefusal['status'],
  message: string
): OrgDriveRefusal => ({ ok: false, code, status, message });

const isOrgAdmin = (role: OrgRole | null): boolean => role === 'OWNER' || role === 'ADMIN';

/** The lead (drives.ownerId) of an org drive must be a member of that org (O-7). */
export function canLeadOrgDrive(orgRole: OrgRole | null): boolean {
  return orgRole !== null;
}

export function decideMoveDriveIntoOrg({
  drive,
  actorId,
  actorOrgRole,
}: {
  drive: MoveInDrive;
  actorId: string;
  /** The actor's role in the TARGET org; null when not a member. */
  actorOrgRole: OrgRole | null;
}): { ok: true } | OrgDriveRefusal {
  // Ownership first: a caller who does not own the drive learns nothing more about it (not
  // that it is a Home drive, nor whether it already belongs to an org).
  if (drive.ownerId !== actorId) {
    return refuse('NOT_DRIVE_OWNER', 403, 'Only the drive owner can move a drive into an organization.');
  }
  if (isHomeDrive(drive)) {
    return refuse('HOME_DRIVE', 403, homeDriveActionError(drive, 'org-move') ?? '');
  }
  if (!canLeadOrgDrive(actorOrgRole)) {
    return refuse('NOT_ORG_MEMBER', 403, 'You must be a member of the organization to move a drive into it.');
  }
  if (drive.orgId !== null) {
    return refuse('ALREADY_IN_ORG', 409, 'This drive already belongs to an organization.');
  }
  if (drive.isTrashed) {
    return refuse('DRIVE_TRASHED', 409, 'Restore this drive from trash before moving it into an organization.');
  }
  return { ok: true };
}

export function decideMoveDriveOutOfOrg({
  drive,
  actorOrgRole,
  implicitMembers,
}: {
  drive: { orgId: string | null };
  /** The actor's role in the org that owns the drive; null when not a member. */
  actorOrgRole: OrgRole | null;
  implicitMembers: ImplicitMembersChoice | null;
}): { ok: true; implicitMembers: ImplicitMembersChoice } | OrgDriveRefusal {
  // Authority first: a caller who is not an admin of the drive's org learns nothing about
  // whether the drive belongs to an org.
  if (!isOrgAdmin(actorOrgRole)) {
    return refuse('NOT_ORG_ADMIN', 403, 'Only an organization Owner or Admin can move a drive out.');
  }
  if (drive.orgId === null) {
    return refuse('NOT_IN_ORG', 409, 'This drive does not belong to an organization.');
  }
  if (implicitMembers === null) {
    return refuse(
      'IMPLICIT_MEMBERS_CHOICE_REQUIRED',
      400,
      'Choose whether organization members keep access as invited members or are removed.'
    );
  }
  return { ok: true, implicitMembers };
}

export function decideCreateDriveInOrg({
  actorOrgRole,
  creationPolicy,
}: {
  actorOrgRole: OrgRole | null;
  creationPolicy: OrgDriveCreationPolicy;
}): { ok: true } | OrgDriveRefusal {
  if (!canLeadOrgDrive(actorOrgRole)) {
    return refuse('NOT_ORG_MEMBER', 403, 'You must be a member of the organization to create a drive in it.');
  }
  if (creationPolicy === 'admins' && !isOrgAdmin(actorOrgRole)) {
    return refuse('POLICY_FORBIDS_CREATE', 403, 'Only organization Owners and Admins can create drives in this organization.');
  }
  return { ok: true };
}

/**
 * The visibility columns for a new or moved-in org drive (DRV-4): nothing unless the
 * person chose one, so the database default (OPEN) applies.
 */
export function orgDriveVisibilityForInsert(
  chosen: OrgDriveVisibility | undefined
): { orgVisibility?: OrgDriveVisibility } {
  return chosen === undefined ? {} : { orgVisibility: chosen };
}

/** The per-org slug index on drives (D-OW-15). */
export const ORG_DRIVE_SLUG_CONSTRAINT = 'drives_org_slug_unique';
/** How many times a create or move-in re-runs after losing the per-org slug race. */
export const ORG_SLUG_ATTEMPTS = 5;

/**
 * True only for a unique violation on the per-org slug index. Drizzle rethrows driver errors
 * with the pg error on `.cause`; any other constraint, or a 23505 without one, is not a slug race.
 */
function isOrgSlugConflict(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const cause = (error as { cause?: { code?: unknown; constraint?: unknown } }).cause;
  return cause?.code === '23505' && cause.constraint === ORG_DRIVE_SLUG_CONSTRAINT;
}

/**
 * Two writers can pick the same free slug inside one org at once; the per-org unique index
 * admits one and aborts the other's transaction. `run` must be a whole transaction: re-running it
 * sees the winner's slug and takes the next suffix. Bounded, and never retries any other error.
 */
export async function retryOnOrgSlugConflict<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= ORG_SLUG_ATTEMPTS || !isOrgSlugConflict(error)) throw error;
    }
  }
}
