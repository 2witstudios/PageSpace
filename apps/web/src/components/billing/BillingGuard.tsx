'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';
import { getBillingRedirect } from '@/lib/billing';

interface BillingGuardProps {
  children: React.ReactNode;
}

/**
 * Guard component that redirects iOS Capacitor users away from billing pages.
 *
 * Apple App Store guidelines require in-app purchases for digital goods,
 * so we hide external payment methods (Stripe) from the iOS app.
 *
 * @example
 * ```tsx
 * // In a billing page
 * export default function BillingPage() {
 *   return (
 *     <BillingGuard>
 *       <BillingPageContent />
 *     </BillingGuard>
 *   );
 * }
 * ```
 */
export function BillingGuard({ children }: BillingGuardProps) {
  const router = useRouter();
  const { hideBilling, isReady } = useBillingVisibility();

  useEffect(() => {
    if (isReady && hideBilling) {
      router.replace(getBillingRedirect());
    }
  }, [isReady, hideBilling, router]);

  // Don't render anything while redirecting to prevent flash of content
  if (!isReady || hideBilling) {
    return null;
  }

  return <>{children}</>;
}
