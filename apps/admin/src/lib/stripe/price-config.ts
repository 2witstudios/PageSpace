import { stripeConfig } from '../stripe-config';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';

export const STRIPE_PRICE_TO_TIER: Record<string, SubscriptionTier> = {
  [stripeConfig.priceIds.pro]: 'pro',
  [stripeConfig.priceIds.business]: 'business',
  // Grandfathered (A-9): the removed Founder price resolves to its migration target.
  [stripeConfig.grandfatheredPriceIds.founder]: 'pro',
};

const LEGACY_PRICE_AMOUNTS: Record<number, SubscriptionTier> = {
  1500: 'pro',
  2999: 'pro',
  5000: 'business', // $50 Business, the org plan (SEAT-2)
  10000: 'business', // $100 legacy personal Business (grandfathered, A-9)
  19999: 'business',
};

export function getTierFromPrice(priceId: string, priceAmount?: number | null): SubscriptionTier {
  const tierFromId = STRIPE_PRICE_TO_TIER[priceId];
  if (tierFromId) return tierFromId;
  if (priceAmount != null) {
    const tierFromAmount = LEGACY_PRICE_AMOUNTS[priceAmount];
    if (tierFromAmount) return tierFromAmount;
  }
  return 'free';
}
