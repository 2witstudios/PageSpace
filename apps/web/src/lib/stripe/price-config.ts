import { stripeConfig } from '../stripe-config';
import { tierFromConfiguredPrice, type SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';

/** The price identity carried by a Stripe invoice line. */
export type InvoiceLinePricing = {
  parent?: { subscription_item_details?: { subscription_item?: string | null } | null } | null;
  pricing?: {
    price_details?: { price?: string | { id: string } | null } | null;
  } | null;
};

/** Resolve all subscription lines; unknown proration lines cannot hide a configured plan. */
export function tierFromInvoiceLines(lines: readonly InvoiceLinePricing[]): Exclude<SubscriptionTier, 'business'> {
  const tiers = new Set<SubscriptionTier>();
  for (const line of lines) {
    if (!line.parent?.subscription_item_details) continue;
    const price = line.pricing?.price_details?.price;
    const priceId = typeof price === 'string' ? price : price?.id;
    const tier = priceId ? getTierFromPrice(priceId) : 'free';
    if (tier !== 'free') tiers.add(tier);
  }
  return tiers.size === 1 && tiers.has('pro') ? 'pro' : 'free';
}

/** Unknown, retired and unconfigured prices have no paid entitlement. */
export function getTierFromPrice(priceId: string): SubscriptionTier {
  return tierFromConfiguredPrice(priceId, {
    pro: stripeConfig.priceIds.pro,
    business: stripeConfig.orgPriceIds.businessBase,
  });
}

/** Personal billing cannot grant organization Business entitlements. */
export function getPersonalTierFromPrice(priceId: string): Exclude<SubscriptionTier, 'business'> {
  return getTierFromPrice(priceId) === 'pro' ? 'pro' : 'free';
}
