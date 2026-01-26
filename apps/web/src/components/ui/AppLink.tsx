'use client';

import { useRouter } from 'next/navigation';
import { MouseEvent, ReactNode, AnchorHTMLAttributes } from 'react';
import { isInternalUrl, openExternalUrl } from '@/lib/navigation/app-navigation';

interface AppLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string;
  children: ReactNode;
}

/**
 * Mobile-aware link component
 * - Internal links: Uses router.push (stays in WebView on Capacitor)
 * - External links: Uses Browser.open on mobile (Safari View Controller)
 *
 * Use this instead of plain <a> tags when you need links that work correctly
 * in both web browsers and the iOS Capacitor app.
 */
export function AppLink({ href, children, onClick, ...props }: AppLinkProps) {
  const router = useRouter();

  const handleClick = async (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();

    // Call any custom onClick handler first
    onClick?.(e);

    if (isInternalUrl(href)) {
      router.push(href);
    } else {
      await openExternalUrl(href);
    }
  };

  return (
    <a href={href} onClick={handleClick} {...props}>
      {children}
    </a>
  );
}

export default AppLink;
