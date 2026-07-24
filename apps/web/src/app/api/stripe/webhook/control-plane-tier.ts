/**
 * Typed mapping at the web→control-plane provisioning boundary (#2148).
 *
 * control-plane validates tenant tier against its OWN vocabulary
 * (`apps/control-plane/src/validation/tenant-validation.ts` VALID_TIERS —
 * 'free' | 'pro' | 'business' | 'enterprise', a superset/subset mismatch with
 * the canonical SaaS SubscriptionTier: it lacks 'founder' and adds
 * 'enterprise', which control-plane sells only through its own direct tenant
 * checkout). Forwarding a raw SaaS tier string (as the webhook used to)
 * silently fails control-plane's tenant-validation for a 'founder' checkout.
 *
 * This function is the one place that resolves a SaaS tier to whatever
 * control-plane accepts. The `switch`'s exhaustiveness check
 * (assertNeverTier) means adding a member to the canonical TIERS array
 * without updating this mapping fails `tsc`, not just a test.
 */
import { assertNeverTier, type SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';

/** control-plane's own tenant tier vocabulary (VALID_TIERS in tenant-validation.ts). */
export type ControlPlaneTier = 'free' | 'pro' | 'business' | 'enterprise';

export function resolveControlPlaneTier(tier: SubscriptionTier): ControlPlaneTier {
  switch (tier) {
    case 'free':
      return 'free';
    case 'pro':
      return 'pro';
    // control-plane has no dedicated 'founder' price/tier; 'business' is the
    // closest available tier that doesn't under-entitle a founder tenant.
    case 'founder':
      return 'business';
    case 'business':
      return 'business';
    default:
      return assertNeverTier(tier);
  }
}
