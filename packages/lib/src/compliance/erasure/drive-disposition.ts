/**
 * Pure decision for what happens to a departing owner's drives during erasure.
 *
 * Today's synchronous path hard-blocks (HTTP 400) the instant any owned drive
 * has co-members, with no escape hatch (#908). This function expresses both the
 * default protective behaviour AND the admin force-delete escalation as a
 * deterministic plan; the runner merely executes it.
 */

export interface OwnedDriveWithMembers {
  id: string;
  name: string;
  /** Total members on the drive, owner included. */
  memberCount: number;
  /**
   * Set when an org owns the drive and the departing person only leads it (Spec DRV-1).
   * Such a drive is the org's, not theirs: it is never deleted and never blocks erasure;
   * its lead is reassigned to the org Owner before the user row goes (O-7). Required, not
   * optional: a caller that forgot it would silently plan an org drive for deletion.
   */
  orgId: string | null;
}

export interface DriveDispositionPlan {
  soloDriveIds: string[];
  multiMemberDriveIds: string[];
  multiMemberDriveNames: string[];
  /** Drives the runner should delete (empty when blocked). */
  drivesToDelete: string[];
  /** Subset of drivesToDelete that only die because of force escalation. */
  forcedDriveIds: string[];
  /** True when multi-member drives exist and no force escalation was granted. */
  blocked: boolean;
  /** Org drives the person leads: kept, and handed to the org Owner (O-7). */
  orgDriveIds: string[];
}

export interface DriveDispositionOptions {
  forceDelete: boolean;
}

const isSolo = (drive: OwnedDriveWithMembers): boolean => drive.memberCount <= 1;

export function planDriveDisposition(
  drives: OwnedDriveWithMembers[],
  options: DriveDispositionOptions
): DriveDispositionPlan {
  const personal = drives.filter((d) => !d.orgId);
  const orgDriveIds = drives.filter((d) => !!d.orgId).map((d) => d.id);
  const solo = personal.filter(isSolo);
  const multi = personal.filter((d) => !isSolo(d));

  const soloDriveIds = solo.map((d) => d.id);
  const multiMemberDriveIds = multi.map((d) => d.id);
  const multiMemberDriveNames = multi.map((d) => d.name);

  if (multi.length > 0 && !options.forceDelete) {
    // Protective default: refuse to orphan co-members; nothing is deleted.
    return {
      soloDriveIds,
      multiMemberDriveIds,
      multiMemberDriveNames,
      drivesToDelete: [],
      forcedDriveIds: [],
      blocked: true,
      orgDriveIds,
    };
  }

  // Either no multi-member drives, or force escalation grants their deletion.
  return {
    soloDriveIds,
    multiMemberDriveIds,
    multiMemberDriveNames,
    drivesToDelete: [...soloDriveIds, ...multiMemberDriveIds],
    forcedDriveIds: options.forceDelete ? multiMemberDriveIds : [],
    blocked: false,
    orgDriveIds,
  };
}
