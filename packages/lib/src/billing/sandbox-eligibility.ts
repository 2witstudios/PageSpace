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
 *
 * Deployment-mode aware, at ONE seam: `resolveEffectiveSandboxTier` answers
 * "what tier does this payer effectively hold HERE", and every gate — this
 * module's `isSandboxAvailable`, and every tier-indexed ceiling in
 * `services/sandbox/quota.ts` — goes through it. Tenant deployments have no
 * meaningful stored tier (no Stripe, nothing writes the column), so they resolve
 * to `TENANT_EFFECTIVE_SANDBOX_TIER` rather than being denied for looking free.
 * Call sites do NOT branch on the mode themselves; adding an `isTenantMode()`
 * check next to a tier read is the bug this seam exists to prevent.
 */

import { getDeploymentMode, type DeploymentMode } from '../deployment-mode';
import { resolveSessionPayerId } from './sandbox-payer';
import type { SubscriptionTier } from './subscription-tiers';

/** Tiers for which the sandbox (Sprite compute, code execution, terminal) is available. */
export const SANDBOX_ELIGIBLE_TIERS: readonly SubscriptionTier[] = ['pro', 'founder', 'business'];

/**
 * The tier a TENANT deployment's payers are treated as holding for every sandbox
 * decision — eligibility AND every ceiling derived from tier.
 *
 * Tenant is a dedicated per-customer image with a non-Stripe billing path
 * (`isBillingEnabled()` is already false for it), so the `users.subscriptionTier`
 * column there is not a purchase record — nothing sells or reconciles it, and the
 * control-plane seeder deliberately doesn't set it, so it sits at the column
 * default `free`. Gating tenant compute on that value denies the whole sandbox
 * surface to a customer who bought the deployment outright. `subscription-utils`
 * already resolves storage limits the same way (tenant → business regardless of
 * the stored tier); this is that idiom applied to compute.
 *
 * Business — not an "unlimited" sentinel — precisely so the runaway guards keep
 * biting: a tenant payer still gets the business concurrency ceiling, the
 * business live-sandbox ceiling and the business environment count, each still
 * overridable per deployment by its own env var (`CODE_EXEC_CONCURRENCY_BUSINESS`,
 * `DRIVE_ENV_LIMIT_BUSINESS`). A tenant is its own deployment, so those knobs ARE
 * the tenant's knobs.
 */
export const TENANT_EFFECTIVE_SANDBOX_TIER: SubscriptionTier = 'business';

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
 * THE seam. Normalizes "what tier does this payer effectively hold, for sandbox
 * purposes, in THIS deployment" — once, at the door — so no gate has to know that
 * deployment mode is part of the question.
 *
 * Pure in the mode so it is exhaustively testable without env stubbing; the
 * env-reading edge is {@link resolveEffectiveSandboxTier}.
 *
 * - cloud  — the stored tier, unchanged. Tier IS the purchase record.
 * - tenant — {@link TENANT_EFFECTIVE_SANDBOX_TIER}; see its doc for why the
 *            stored tier is meaningless there.
 * - onprem — the stored tier, unchanged, i.e. NOT exempt. Deliberate: on-prem's
 *            answer to code execution is a local bridge to the operator's own
 *            shell, not a Fly Sprite this deployment cannot reach or bill. Do not
 *            "fix" onprem by adding it here.
 *
 * Idempotent (the tenant answer is itself an eligible tier), so normalizing twice
 * is harmless — which is why every gate below can normalize defensively.
 */
export function resolveEffectiveSandboxTierForMode(
  tier: SubscriptionTier,
  mode: DeploymentMode,
): SubscriptionTier {
  return mode === 'tenant' ? TENANT_EFFECTIVE_SANDBOX_TIER : tier;
}

/** {@link resolveEffectiveSandboxTierForMode} against the running deployment's mode. */
export function resolveEffectiveSandboxTier(tier: SubscriptionTier): SubscriptionTier {
  return resolveEffectiveSandboxTierForMode(tier, getDeploymentMode());
}

/**
 * The GATE: may a payer holding this stored tier have cloud machines here?
 *
 * The sandbox is a paid feature on cloud; free-tier payers get session/chat/panes
 * but no compute. On tenant the deployment itself is the purchase, so the stored
 * tier is normalized away first (§ {@link resolveEffectiveSandboxTier}).
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
