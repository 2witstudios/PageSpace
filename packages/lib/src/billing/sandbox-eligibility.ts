/**
 * Shared compute eligibility and resource ceilings. Personal cloud plans and org
 * entitlements retain their tier. Billing-disabled installations derive capability
 * from the deployment, never from a synthetic personal subscription record.
 */

import { getDeploymentMode, type DeploymentMode } from '../deployment-mode';
import { deploymentCapabilityTier } from './deployment-capability';
import { resolveSessionPayer, type LookupDriveBillingFacts } from './sandbox-payer';
import { computeChargeFor, computeChargeTier } from './compute-charge';
import { orgEntitlementTier } from './spend-target';
import type { SubscriptionTier } from './subscription-tiers';

/** Tiers for which the sandbox (Sprite compute, code execution, terminal) is available. */
export const SANDBOX_ELIGIBLE_TIERS: readonly SubscriptionTier[] = ['pro', 'business'];

/**
 * PURE tier-table check: does this tier's PLAN include cloud machines?
 *
 * This is the pricing/display question ("does Pro include the sandbox?"), not the
 * runtime gate. Gates must call {@link isSandboxAvailable} instead, which asks the
 * deployment-aware question. Exported for surfaces that genuinely describe the
 * cloud price list (marketing pricing table) rather than authorizing a request.
 */
export function isSandboxTierEligible(tier: SubscriptionTier): boolean {
  return SANDBOX_ELIGIBLE_TIERS.includes(tier);
}

/**
 * Pure deployment capability resolution, shared by admission and quota checks.
 * Tenant and on-prem have no personal Stripe billing. Their users store Free,
 * while configured compute (including local bridge binding) keeps Business limits.
 * Kill-switches, permissions, provider configuration and org policies remain required.
 */
export function resolveEffectiveSandboxTierForMode(
  tier: SubscriptionTier,
  mode: DeploymentMode,
): SubscriptionTier {
  return deploymentCapabilityTier(tier, mode);
}

/** {@link resolveEffectiveSandboxTierForMode} against the running deployment's mode. */
export function resolveEffectiveSandboxTier(tier: SubscriptionTier): SubscriptionTier {
  return resolveEffectiveSandboxTierForMode(tier, getDeploymentMode());
}

/**
 * The GATE: may a payer holding this stored tier have cloud machines here?
 *
 * The sandbox is a paid feature on cloud; free-tier payers get session/chat/panes
 * but no compute. On billing-disabled installations capability follows the deployment, so the
 * stored personal tier is normalized away first (§ {@link resolveEffectiveSandboxTier}).
 */
export function isSandboxAvailable(tier: SubscriptionTier): boolean {
  return isSandboxTierEligible(resolveEffectiveSandboxTier(tier));
}

export interface ResolveSandboxPayerTierInput {
  /** The session's own drive; null for a user-scoped global-assistant session. */
  driveId: string | null;
  /** The session's own owner — the fallback payer, and the ONLY payer when `driveId` is null. */
  ownerId: string;
}

export interface ResolveSandboxPayerTierDeps {
  lookupDriveBillingFacts: LookupDriveBillingFacts;
  getUserSubscriptionTier: (userId: string) => Promise<SubscriptionTier>;
  /**
   * SEAT-9 / WAL-8: whether the paying org is LAPSED (it then confers no tier). Production passes
   * the org's status read (can-run-code's default deps); a caller that omits it reads every org as paid.
   */
  isOrgLapsed?: (orgId: string) => Promise<boolean>;
}

/**
 * Resolves the session's payer (§ `resolveSessionPayer`), then the tier its compute follows: an
 * org drive's session runs on the ORG's entitlement (SEAT-8, WAL-9) — whatever the lead's or the
 * member's own plan — and is billed to the org pool; a personal session on its payer's own tier.
 * An org payer never falls back to a person's tier.
 */
export async function resolveSandboxPayerTier(
  input: ResolveSandboxPayerTierInput,
  deps: ResolveSandboxPayerTierDeps,
): Promise<SubscriptionTier> {
  const payer = await resolveSessionPayer({
    driveId: input.driveId,
    ownerId: input.ownerId,
    lookupDriveBillingFacts: deps.lookupDriveBillingFacts,
  });
  if (payer.kind === 'org') {
    const lapsed = deps.isOrgLapsed ? await deps.isOrgLapsed(payer.orgId) : false;
    return computeChargeTier(computeChargeFor(payer, input.ownerId), 'free', lapsed);
  }
  return deps.getUserSubscriptionTier(payer.userId);
}

/**
 * The tier a drive's compute follows, for the sites that already hold the drive row and the
 * paying person's stored tier (quota ceilings, env allowance, slot eligibility): the ORG's
 * entitlement for an org drive (WAL-9, SEAT-8) — never the lead's own plan — else `ownerTier`.
 * A LAPSED org confers no paid tier (SEAT-9, WAL-8): `orgLapsed` is REQUIRED (review #2761) — read it
 * with `isOrgLapsedForDrive` (organizations/status); it is ignored for a personal drive.
 * A driveless (global-assistant) session passes no drive and keeps its owner's tier.
 */
export function computeTierForDrive(
  drive: { orgId: string | null } | null | undefined,
  ownerTier: SubscriptionTier,
  orgLapsed: boolean,
): SubscriptionTier {
  return drive?.orgId ? orgEntitlementTier(orgLapsed) : ownerTier;
}
