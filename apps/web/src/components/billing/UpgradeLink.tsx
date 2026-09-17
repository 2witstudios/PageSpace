'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useBillingVisibility } from '@/hooks/useBillingVisibility';

interface UpgradeLinkProps {
  href: string;
  /** Link text where purchases are allowed. */
  children: ReactNode;
  /** Plain text where they are not (iOS, Guideline 3.1.1) — never a call to action. */
  fallback: ReactNode;
  className?: string;
}

/**
 * An inline link to a purchase page that degrades to plain text wherever billing
 * is hidden. Follows `showBilling`, so it also renders the fallback until platform
 * detection finishes rather than flashing a link on iOS.
 */
export function UpgradeLink({ href, children, fallback, className }: UpgradeLinkProps) {
  const { showBilling } = useBillingVisibility();
  if (!showBilling) return <>{fallback}</>;
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
