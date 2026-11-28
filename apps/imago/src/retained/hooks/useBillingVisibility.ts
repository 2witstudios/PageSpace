'use client';

import { useCapacitor } from './useCapacitor';
import { isBillingEnabled } from '@/retained/lib/deployment-mode';
import { resolveBillingChannel, type BillingChannel } from '@/retained/lib/billing/billing-visibility';

export { resolveBillingChannel, type BillingChannel } from '@/retained/lib/billing/billing-visibility';

/**
 * Mirror of apps/web's `BillingVisibility` (same fields, same meaning).
 */
export interface BillingVisibility {
  /** Whether STRIPE billing UI should be shown — true only on the `'stripe'` channel. */
  showBilling: boolean;
  /** Whether Stripe billing UI should be hidden (true on iOS); drives redirects. */
  hideBilling: boolean;
  /** Whether platform detection is complete (for SSR hydration safety) */
  isReady: boolean;
  /** Which store may sell here. */
  channel: BillingChannel;
  /** Whether surfaces that can sell on either store may show a purchase CTA. */
  showPurchases: boolean;
}

/**
 * Billing UI visibility for the retained (classic) surfaces inside Imago.
 *
 * Mirrors apps/web's hook, with one deliberate difference: Imago ships no
 * StoreKit (In-App Purchase) client, so it never resolves the `'apple'`
 * channel — on iOS it stays `'none'` (every purchase surface hidden, today's
 * App Store–compliant behaviour) even on a binary that has the PageSpaceStore
 * plugin. Purchases in the iOS app happen in the classic web app.
 */
export function useBillingVisibility(): BillingVisibility {
  const { isIOS, isReady } = useCapacitor();

  // Non-cloud (on-prem, tenant): always hide billing, immediately ready
  if (!isBillingEnabled()) {
    return { showBilling: false, hideBilling: true, isReady: true, channel: 'none', showPurchases: false };
  }

  const channel = resolveBillingChannel({ billingEnabled: true, isReady, isIOS, storeKitAvailable: false });

  return {
    /**
     * False until platform detection finishes, not true: this gates purchase
     * surfaces, and the unsafe direction is showing one we later retract.
     */
    showBilling: channel === 'stripe',
    /**
     * Deliberately NOT the negation of `showBilling`: this drives redirects, and
     * redirecting before detection completes would bounce web users off their
     * own billing pages.
     */
    hideBilling: isReady && isIOS,
    isReady,
    channel,
    showPurchases: channel !== 'none',
  };
}
