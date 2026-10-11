import { stripeConfig } from '../stripe-config';
import { tierFromConfiguredPrice, type SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';

/** The price identity carried by a Stripe invoice line. */
export type InvoiceLinePricing = {
  pricing?: {
    price_details?: { price?: string | { id: string } | null } | null;
  } | null;
};

/** Resolve an invoice line from its price ID; amounts never establish entitlement. */
export function tierFromInvoiceLine(line: InvoiceLinePricing | undefined): SubscriptionTier | undefined {
  const price = line?.pricing?.price_details?.price;
  const priceId = typeof price === 'string' ? price : price?.id;
  return priceId ? getTierFromPrice(priceId) : undefined;
}

/** Unknown, retired and unconfigured prices have no paid entitlement. */
export function getTierFromPrice(priceId: string): SubscriptionTier {
  return tierFromConfiguredPrice(priceId, {
    pro: stripeConfig.priceIds.pro,
    business: stripeConfig.orgPriceIds.businessBase,
  });
}
