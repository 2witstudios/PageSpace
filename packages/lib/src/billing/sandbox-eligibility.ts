/**
 * Sandbox eligibility — is a session's PAYER on a tier that includes real
 * cloud-machine compute (a Sprite VM, code execution, the terminal)? All
 * interface capability (chat, panes, sessions, GitHub tools) is free for
 * every authenticated user; only the sandbox itself is gated here.
 *
 * Payer, not actor: `resolveSandboxPayerTier` reuses `resolveSessionPayerId`
 * (the same drive-owner-else-session-owner rule billing/quota already apply)
 * so a free-tier collaborator in a Pro-owned drive still gets sandbox access,
 * billed to the drive's owner — eligibility and billing stay on one axis.
 */

import { resolveSessionPayerId } from './sandbox-payer';
import type { SubscriptionTier } from './subscription-tiers';

/** Tiers for which the sandbox (Sprite compute, code execution, terminal) is available. */
export const SANDBOX_ELIGIBLE_TIERS: readonly SubscriptionTier[] = ['pro', 'founder', 'business'];

/** The sandbox is a paid feature; free-tier payers get session/chat/panes but no compute. */
export function isSandboxAvailable(tier: SubscriptionTier): boolean {
  return SANDBOX_ELIGIBLE_TIERS.includes(tier);
}

export interface ResolveSandboxPayerTierInput {
  /** The session's own drive; null for a user-scoped global-assistant session. */
  driveId: string | null;
  /** The session's own owner — the fallback payer, and the ONLY payer when `driveId` is null. */
  ownerId: string;
}

export interface ResolveSandboxPayerTierDeps {
  lookupDriveOwnerId: (driveId: string) => Promise<string | null>;
  getUserSubscriptionTier: (userId: string) => Promise<SubscriptionTier>;
}

/** Resolves the session's payer (§ `resolveSessionPayerId`), then that payer's tier. */
export async function resolveSandboxPayerTier(
  input: ResolveSandboxPayerTierInput,
  deps: ResolveSandboxPayerTierDeps,
): Promise<SubscriptionTier> {
  const payerId = await resolveSessionPayerId({
    driveId: input.driveId,
    ownerId: input.ownerId,
    lookupDriveOwnerId: deps.lookupDriveOwnerId,
  });
  return deps.getUserSubscriptionTier(payerId);
}
