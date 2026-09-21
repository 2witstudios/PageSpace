'use client';

import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { isCapacitorApp } from '@/lib/capacitor-bridge';
import { openExternalUrl } from '@/lib/navigation/app-navigation';

interface MarketingLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** A same-host path served by the marketing site, e.g. `/terms`. */
  href: string;
  children: ReactNode;
}

/**
 * Link to a page the marketing site serves on our own host (Terms, Privacy, …).
 *
 * `AppLink` treats same-host paths as internal, which in the native app loads the
 * whole marketing site — Pricing nav included — inside the web view. Here the
 * native app opens the page in the system browser sheet instead; the web
 * navigates normally.
 */
export function MarketingLink({ href, children, onClick, ...props }: MarketingLinkProps) {
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (!isCapacitorApp()) return;
    e.preventDefault();
    void openExternalUrl(new URL(href, window.location.origin).toString());
  };

  return (
    <a href={href} onClick={handleClick} {...props}>
      {children}
    </a>
  );
}
