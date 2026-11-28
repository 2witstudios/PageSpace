'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useBillingVisibility, type BillingChannel } from '@/hooks/useBillingVisibility';

interface UpgradeLinkProps {
  href: string;
  /** Link text where purchases are allowed. */
  children: ReactNode;
  /** Plain text where they are not (no store may sell here, Guideline 3.1.1) — never a call to action. */
  fallback: ReactNode;
  className?: string;
}

/** The in-app plan page — the one purchase page that also sells on the Apple channel. */
const PLAN_PAGE = '/settings/plan';

/**
 * Whether an upgrade link to `href` may render on `channel`. Pure.
 *
 * Stripe: any purchase page. Apple (iOS with StoreKit): only the plan page,
 * which sells through In-App Purchase — never a Stripe page like
 * /settings/billing. None: nothing.
 */
export function upgradeLinkAllowed(channel: BillingChannel | undefined, showBilling: boolean, href: string): boolean {
  if (showBilling) return true;
  if (channel !== 'apple') return false;
  const path = href.split(/[?#]/)[0];
  return path === PLAN_PAGE;
}

/**
 * An inline link to a purchase page that degrades to plain text wherever it may
 * not sell. Follows the billing channel, so it also renders the fallback until
 * platform detection finishes rather than flashing a link on iOS.
 */
export function UpgradeLink({ href, children, fallback, className }: UpgradeLinkProps) {
  const { showBilling, channel } = useBillingVisibility();
  if (!upgradeLinkAllowed(channel, showBilling, href)) return <>{fallback}</>;
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
