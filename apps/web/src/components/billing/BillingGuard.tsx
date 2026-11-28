'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';
import { getBillingRedirect, shouldRedirectFromBillingSurface, type BillingSurface } from '@/lib/billing';

interface BillingGuardProps {
  children: React.ReactNode;
  /**
   * What the guarded page sells through. `'stripe'` (default) pages — the
   * Stripe portal, invoices, payment methods — are reachable only on the Stripe
   * channel. `'purchases'` pages (the plan page) also open on the Apple
   * channel, where they sell through In-App Purchase.
   */
  surface?: BillingSurface;
}

/**
 * Guard component that redirects users away from billing pages their platform
 * may not sell on.
 *
 * Apple App Store guidelines require In-App Purchase for digital goods, so the
 * iOS app never reaches a Stripe surface; on an iOS binary with the StoreKit
 * plugin it may still reach the plan page, which then sells through Apple.
 *
 * @example
 * ```tsx
 * <BillingGuard>{Stripe-only page}</BillingGuard>
 * <BillingGuard surface="purchases">{plan page}</BillingGuard>
 * ```
 */
export function BillingGuard({ children, surface = 'stripe' }: BillingGuardProps) {
  const router = useRouter();
  const { hideBilling, isReady, channel } = useBillingVisibility();
  const redirect = shouldRedirectFromBillingSurface({ surface, isReady, hideBilling, channel });

  useEffect(() => {
    if (redirect) {
      router.replace(getBillingRedirect());
    }
  }, [redirect, router]);

  // Don't render anything while detecting or redirecting to prevent flash of content
  if (!isReady || redirect) {
    return null;
  }

  return <>{children}</>;
}
