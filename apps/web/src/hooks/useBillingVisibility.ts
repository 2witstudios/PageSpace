'use client';

import { useCapacitor } from './useCapacitor';

/**
 * Hook to determine billing UI visibility based on platform.
 *
 * On iOS Capacitor apps, billing UI should be hidden to comply with
 * Apple App Store guidelines (Apple requires in-app purchases for digital goods).
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

  return {
    /** Whether billing UI should be shown (true on web/android, false on iOS) */
    showBilling: isReady ? !isIOS : true,
    /** Whether billing UI should be hidden (true on iOS) */
    hideBilling: isReady && isIOS,
    /** Whether platform detection is complete (for SSR hydration safety) */
    isReady,
  };
}
