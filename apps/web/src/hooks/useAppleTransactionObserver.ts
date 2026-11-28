'use client';

import { useEffect } from 'react';
import { useBillingVisibility } from './useBillingVisibility';

/**
 * Once per app shell, on the Apple billing channel and signed in: attach the
 * StoreKit `transactionUpdated` listener (renewals, Ask to Buy approvals,
 * interrupted purchases, refunds) and drain `Transaction.unfinished`, posting
 * each to the server and finishing it per the IAP contract. Confirmed
 * transactions revalidate the subscription-status and credit SWR caches.
 *
 * The observer itself is reference-counted in `apple-store`, so a shell that
 * remounts (dashboard ↔ settings) does not attach a second listener.
 */
export function useAppleTransactionObserver(isAuthenticated: boolean): void {
  const { channel } = useBillingVisibility();
  const active = channel === 'apple' && isAuthenticated;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let stop: (() => void) | null = null;
    import('@/lib/iap/apple-store')
      .then(({ startAppleTransactionObserver }) => {
        if (!cancelled) stop = startAppleTransactionObserver();
      })
      .catch((err) => console.error('[useAppleTransactionObserver] failed to start', err));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [active]);
}
