'use client';

import { useCapacitor } from './useCapacitor';
import { isBillingEnabled } from '@/lib/deployment-mode';
import { isNativePluginAvailable } from '@/lib/capacitor-bridge';
import { resolveBillingChannel, type BillingChannel } from '@/lib/billing/billing-visibility';
import { PAGESPACE_STORE_PLUGIN } from '@/lib/iap/apple-store-core';

export { resolveBillingChannel, type BillingChannel } from '@/lib/billing/billing-visibility';

export interface BillingVisibility {
  /**
   * Whether STRIPE billing UI should be shown — true only on the `'stripe'`
   * channel. False until platform detection finishes, not true.
   *
   * This gates Stripe purchase surfaces (checkout, portal, invoices, storage
   * add-ons, custom top-ups), so the unsafe direction is showing one we later
   * retract: on iOS the old default rendered "buy credits" affordances for a
   * frame before `useCapacitor` resolved. The default belongs here rather than
   * as `isReady && showBilling` repeated at each caller. The cost on web is one
   * frame without a buy button.
   */
  showBilling: boolean;
  /**
   * Whether Stripe billing UI should be hidden (true on iOS and billing-disabled
   * deployments). Deliberately NOT the negation of `showBilling`: this drives
   * redirects, and redirecting before detection completes would bounce web
   * users off their own billing pages.
   */
  hideBilling: boolean;
  /** Whether platform detection is complete (for SSR hydration safety) */
  isReady: boolean;
  /** Which store may sell here: Stripe (web/Android), Apple (iOS with StoreKit), or none. */
  channel: BillingChannel;
  /**
   * Whether surfaces that can sell on EITHER store may show a purchase CTA
   * (plan page, credit packs, upgrade links to /settings/plan). Stripe-only
   * surfaces keep gating on `showBilling`.
   */
  showPurchases: boolean;
}

/**
 * Hook to determine billing UI visibility based on platform and deployment mode.
 *
 * - Web/Android (cloud): `channel: 'stripe'`, `showBilling: true`.
 * - iOS app with the PageSpaceStore plugin: `channel: 'apple'` — Stripe stays
 *   hidden (`showBilling: false`), In-App Purchase surfaces show
 *   (`showPurchases: true`).
 * - iOS binaries without the plugin and non-cloud deployments (on-prem, tenant):
 *   `channel: 'none'`, nothing purchasable.
 *
 * @example
 * ```tsx
 * const { showBilling, showPurchases, channel } = useBillingVisibility();
 * {showBilling && <StripeOnlyThing />}
 * {showPurchases && <BuyCreditsButton />}
 * ```
 */
export function useBillingVisibility(): BillingVisibility {
  const { isIOS, isReady, capabilities } = useCapacitor();

  // Non-cloud (on-prem, tenant): always hide billing, immediately ready
  if (!isBillingEnabled()) {
    return { showBilling: false, hideBilling: true, isReady: true, channel: 'none', showPurchases: false };
  }

  // The capability says the platform can; the plugin check says this binary does.
  // Only consulted once ready, so the first (server-matching) render never reads window.
  const storeKitAvailable = isReady && capabilities.storeKit && isNativePluginAvailable(PAGESPACE_STORE_PLUGIN);
  const channel = resolveBillingChannel({ billingEnabled: true, isReady, isIOS, storeKitAvailable });

  return {
    showBilling: channel === 'stripe',
    hideBilling: isReady && isIOS,
    isReady,
    channel,
    showPurchases: channel !== 'none',
  };
}
