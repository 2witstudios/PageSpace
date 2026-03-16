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
    /** Whether billing UI should be shown (true on web/android, false on iOS) */
    showBilling: isReady ? !isIOS : true,
    /** Whether billing UI should be hidden (true on iOS) */
    hideBilling: isReady && isIOS,
    /** Whether platform detection is complete (for SSR hydration safety) */
    isReady,
  };
}
