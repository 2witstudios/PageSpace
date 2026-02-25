'use client';

import { useCapacitor } from './useCapacitor';
import { isOnPrem } from '@/lib/deployment-mode';

/**
 * Hook to determine billing UI visibility based on platform and deployment mode.
 *
 * Billing is hidden on iOS Capacitor apps (Apple App Store compliance)
 * and on-prem deployments (no Stripe).
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

  // On-prem: always hide billing, immediately ready
  if (isOnPrem()) {
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
