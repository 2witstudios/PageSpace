import { isSandboxAvailable } from '@pagespace/lib/billing/sandbox-eligibility';
import { toSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';

/**
 * Per-drive sandbox availability for THE REQUESTER: the payer's tier (the
 * drive's OWNER — not the requester's own plan) AND the requester's ability
 * to actually use it — drive edit access plus the code-execution kill switch
 * (review #2326: payer tier alone advertised shell affordances to
 * viewer-role members, and while the kill switch is off, that every
 * enforcement point then 403s). Pure so the batching/dedup logic is
 * unit-testable without a database: `multi-drive/route.ts` supplies the DB
 * reads (accessible drives, the distinct set of their owners' rows, the
 * requester's edit-capable memberships) already done.
 */
export function computeSandboxEligibilityByDrive(
  driveOwners: readonly { id: string; ownerId: string }[],
  ownerRows: readonly { id: string; subscriptionTier: string | null }[],
  actor: {
    userId: string;
    /** Drives where the requester holds an edit-capable membership (ADMIN/MEMBER role). Ownership is checked separately from `driveOwners`. */
    editableDriveIds: ReadonlySet<string>;
    codeExecutionEnabled: boolean;
  },
): Map<string, boolean> {
  const tierByOwnerId = new Map(ownerRows.map((row) => [row.id, toSubscriptionTier(row.subscriptionTier)]));
  return new Map(
    driveOwners.map((drive) => [
      drive.id,
      actor.codeExecutionEnabled &&
        isSandboxAvailable(tierByOwnerId.get(drive.ownerId) ?? 'free') &&
        (drive.ownerId === actor.userId || actor.editableDriveIds.has(drive.id)),
    ]),
  );
}
