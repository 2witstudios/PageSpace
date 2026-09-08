'use client';

import { useCapacitor } from './useCapacitor';
import { isBillingEnabled } from '@/lib/deployment-mode';

/**
 * Hook to determine billing UI visibility based on platform and deployment mode.
 *
 * Billing is hidden on iOS Capacitor apps (Apple App Store compliance)
 * and non-cloud deployments (on-prem, tenant — no in-app Stripe).
 *
 * @example
 * ```tsx
 * const { showBilling, hideBilling, isReady } = useBillingVisibility();
 *
 * // Conditionally render billing UI
 * {showBilling && <BillingButton />}
 *
 * // Or for redirect logic
 * if (isReady && hideBilling) {
 *   router.push('/settings');
 * }
 * ```
 */
export function useBillingVisibility() {
  const { isIOS, isReady } = useCapacitor();

  // Non-cloud (on-prem, tenant): always hide billing, immediately ready
  if (!isBillingEnabled()) {
    return { showBilling: false, hideBilling: true, isReady: true };
  }

  return {
    /**
     * Whether billing UI should be shown. False until platform detection
     * finishes, not true.
     *
     * This gates purchase surfaces, so the unsafe direction is showing one we
     * later retract: on iOS the old default rendered "buy credits" affordances
     * for a frame before `useCapacitor` resolved. Every one of the six callers
     * is a purchase surface, so the default belongs here rather than as
     * `isReady && showBilling` repeated at each of them. The cost on web is one
     * frame without a buy button.
     */
    showBilling: isReady && !isIOS,
    /**
     * Whether billing UI should be hidden (true on iOS). Deliberately NOT the
     * negation of `showBilling`: this drives redirects, and redirecting before
     * detection completes would bounce web users off their own billing pages.
     */
    hideBilling: isReady && isIOS,
    /** Whether platform detection is complete (for SSR hydration safety) */
    isReady,
  };
}
