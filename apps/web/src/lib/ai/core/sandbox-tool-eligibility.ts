/**
 * Whether the sandbox tool families should be REGISTERED for this request —
 * a UX gate, not the security boundary (that's `canRunCode`, re-checked at
 * call time by the tool-gate/runner chain). Without this, a free-tier
 * request would see bash/git tool definitions that hard-fail with
 * `tier_ineligible` the moment they're called, and the GitHub OAuth
 * integration tools would stay wrongly suppressed (their suppression keys on
 * sandbox git tool NAMES being present in the resolved set, regardless of
 * whether those tools would actually work).
 *
 * Payer, not actor: reuses `resolveSandboxPayerTier` (drive owner, or the
 * given userId when driveless), the same rule billing/quota already apply —
 * a free-tier member of a Pro-owned drive still gets the sandbox tools.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { resolveSandboxPayerTier, isSandboxAvailable } from '@pagespace/lib/billing/sandbox-eligibility';
import { lookupDriveOwnerId } from '@pagespace/lib/billing/sandbox-payer';
import { toSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';

async function getUserSubscriptionTier(userId: string) {
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { subscriptionTier: true },
  });
  return toSubscriptionTier(row?.subscriptionTier);
}

/** `driveId`: the agent page's own drive (null for the global assistant). */
export async function resolveSandboxToolEligibility(
  driveId: string | null,
  userId: string,
): Promise<boolean> {
  const tier = await resolveSandboxPayerTier(
    { driveId, ownerId: userId },
    { lookupDriveOwnerId, getUserSubscriptionTier },
  );
  return isSandboxAvailable(tier);
}
