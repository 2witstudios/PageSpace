/**
 * Typed mapping at the web→control-plane provisioning boundary (#2148).
 *
 * control-plane validates tenant tier against its OWN vocabulary
 * (`apps/control-plane/src/validation/tenant-validation.ts` VALID_TIERS —
 * 'free' | 'pro' | 'business' | 'enterprise', a superset of the canonical SaaS
 * SubscriptionTier: it adds 'enterprise', which control-plane sells only
 * through its own direct tenant checkout). Historically the SaaS vocabulary
 * also had a 'founder' tier control-plane did not know; forwarding that raw
 * string silently failed tenant-validation, and coercing every non-SaaS value
 * through the SaaS vocabulary first (an earlier version of the fix) silently
 * downgraded a legitimate 'enterprise' checkout to 'pro'. Founder is gone
 * (A-9) but the exhaustive switch stays: it is what makes the next vocabulary
 * change a tsc failure here instead of a silent provisioning bug.
 *
 * {@link resolveWebhookMetadataTierForControlPlane} owns the WHOLE boundary
 * decision — whether a `session.metadata?.tier` string is a canonical SaaS
 * tier (mapped through the exhaustive switch), or a control-plane-only value
 * (like 'enterprise') that must pass through unchanged — so the webhook route
 * itself never has to re-derive that branch. Any other caller that needs to
 * forward a tier to control-plane's provisioning endpoint (a retry path, a
 * backfill, an admin action) should call this same function rather than
 * reimplementing the vocabulary check.
 */
import { assertNeverTier, isSubscriptionTier, type SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';

/** control-plane's own tenant tier vocabulary (VALID_TIERS in tenant-validation.ts). */
export type ControlPlaneTier = 'free' | 'pro' | 'business' | 'enterprise';

/**
 * Remaps a canonical SaaS tier to control-plane's vocabulary. The exhaustive
 * `switch` (assertNeverTier) means adding a member to the canonical TIERS
 * array without updating this mapping fails `tsc`, not just a test.
 */
export function resolveControlPlaneTier(tier: SubscriptionTier): ControlPlaneTier {
  switch (tier) {
    case 'free':
      return 'free';
    case 'pro':
      return 'pro';
    case 'business':
      return 'business';
    default:
      return assertNeverTier(tier);
  }
}

/**
 * Resolve a raw `session.metadata?.tier` string (from either web's own SaaS
 * checkout or control-plane's own tenant checkout, both of which bridge
 * through this webhook's control-plane provisioning call) to the tier value
 * to send to control-plane's `/api/tenants`.
 *
 *   - a canonical SaaS tier (free/pro/business) goes through
 *     {@link resolveControlPlaneTier}
 *   - anything else — a control-plane-only value like 'enterprise', or a
 *     truly unrecognized string — passes through UNCHANGED, matching the
 *     pre-#2148 behavior for that case (control-plane's own tenant-validation
 *     is the authority on whether it's actually valid)
 *   - a missing/empty value defaults to 'pro', matching the historical default
 */
export function resolveWebhookMetadataTierForControlPlane(rawTier: string | undefined): string {
  if (rawTier && isSubscriptionTier(rawTier)) {
    return resolveControlPlaneTier(rawTier);
  }
  return rawTier || 'pro';
}
