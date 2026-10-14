import { stripeConfig } from '../stripe-config';
import { tierFromConfiguredPrice, type SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';

/** Unknown, retired and unconfigured prices have no paid entitlement. */
export function getTierFromPrice(priceId: string): SubscriptionTier {
  return tierFromConfiguredPrice(priceId, {
    pro: stripeConfig.priceIds.pro,
    business: stripeConfig.orgPriceIds.businessBase,
  });
}
