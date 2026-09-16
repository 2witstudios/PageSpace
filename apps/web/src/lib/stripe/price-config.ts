import { stripeConfig } from '../stripe-config';
import type { SubscriptionTier } from '../subscription/plans';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Mapping from Stripe price IDs to subscription tiers.
 * This is the authoritative source for tier detection from webhooks.
 */
export const STRIPE_PRICE_TO_TIER: Record<string, SubscriptionTier> = {
  // Current prices
  [stripeConfig.priceIds.pro]: 'pro',
  [stripeConfig.priceIds.business]: 'business',
  // Grandfathered prices (A-9): no longer sold, still resolve for the
  // subscribers on them. The removed Founder tier maps to its migration
  // target, Pro; the subscription itself moves at period end by a manual
  // Stripe dashboard step ([D-OW-19]).
  [stripeConfig.grandfatheredPriceIds.founder]: 'pro',
};

/**
 * Legacy price amounts (in cents) for backward compatibility.
 * These are only used as a fallback when price ID is not in the mapping.
 */
export const LEGACY_PRICE_AMOUNTS: Record<number, SubscriptionTier> = {
  1500: 'pro',      // $15 - current Pro
  2999: 'pro',      // $29.99 - legacy Pro
  5000: 'business', // $50 - Business, the org plan (SEAT-2); the removed Founder price is matched by id above
  10000: 'business', // $100 - legacy personal Business (grandfathered, A-9)
  19999: 'business', // $199.99 - legacy Business
};

/**
 * Determine subscription tier from a Stripe price.
 *
 * @param priceId - The Stripe price ID
 * @param priceAmount - The price amount in cents (fallback for unknown price IDs)
 * @returns The subscription tier, or 'free' if not recognized
 */
export function getTierFromPrice(priceId: string, priceAmount?: number | null): SubscriptionTier {
  // First, check if we recognize the price ID
  const tierFromId = STRIPE_PRICE_TO_TIER[priceId];
  if (tierFromId) {
    return tierFromId;
  }

  // Fallback to price amount for legacy/unknown prices
  if (priceAmount != null) {
    const tierFromAmount = LEGACY_PRICE_AMOUNTS[priceAmount];
    if (tierFromAmount) {
      loggers.api.warn('Unknown Stripe price ID, falling back to amount-based tier', { priceId, tierFromAmount });
      return tierFromAmount;
    }
  }

  // Log unknown price for debugging - this shouldn't happen in production
  loggers.api.error('Unknown Stripe price, defaulting to free', undefined, { priceId, priceAmount });
  return 'free';
}
