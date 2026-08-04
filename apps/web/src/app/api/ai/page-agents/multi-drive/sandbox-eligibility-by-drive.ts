import { isSandboxAvailable } from '@pagespace/lib/billing/sandbox-eligibility';
import { toSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';

/**
 * Per-drive sandbox eligibility, keyed by the drive's OWNER (the payer) —
 * not the requester. Pure so the batching/dedup logic is unit-testable
 * without a database: `multi-drive/route.ts` supplies the two DB reads
 * (accessible drives, and the distinct set of their owners' rows) already
 * done.
 */
export function computeSandboxEligibilityByDrive(
  driveOwners: readonly { id: string; ownerId: string }[],
  ownerRows: readonly { id: string; subscriptionTier: string | null }[],
): Map<string, boolean> {
  const tierByOwnerId = new Map(ownerRows.map((row) => [row.id, toSubscriptionTier(row.subscriptionTier)]));
  return new Map(
    driveOwners.map((drive) => [drive.id, isSandboxAvailable(tierByOwnerId.get(drive.ownerId) ?? 'free')]),
  );
}
