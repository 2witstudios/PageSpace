import { stripeConfig } from '../stripe-config';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';

export const STRIPE_PRICE_TO_TIER: Record<string, SubscriptionTier> = {
  [stripeConfig.priceIds.pro]: 'pro',
  [stripeConfig.priceIds.founder]: 'founder',
  [stripeConfig.priceIds.business]: 'business',
};

const LEGACY_PRICE_AMOUNTS: Record<number, SubscriptionTier> = {
  1500: 'pro',
  2999: 'pro',
  5000: 'founder',
  10000: 'business',
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
