/**
 * App Navigation Utilities
 *
 * Handles navigation in a way that works correctly across web and Capacitor iOS.
 *
 * Key behaviors in Capacitor WebView:
 * - Plain <a href="/path"> stays in WebView
 * - target="_blank" or window.open() opens Safari (escapes app)
 * - router.push() stays in WebView
 * - Capacitor Browser.open() opens Safari View Controller (in-app browser)
 */

import { isCapacitorApp } from '@/lib/capacitor-bridge';

/**
 * Check if URL is internal to our app
 */
export function isInternalUrl(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('/')) return true;
  if (typeof window !== 'undefined' && url.startsWith(window.location.origin)) return true;
  return false;
}

/**
 * Capacitor Browser plugin interface (available in iOS/Android app)
 */
interface CapacitorBrowser {
  open(options: { url: string }): Promise<void>;
}

/**
 * Open external URL appropriately for platform
 * - Web: window.open (new tab)
 * - Capacitor: Browser.open (Safari View Controller - stays in app)
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isCapacitorApp()) {
    try {
      // Dynamic import - @capacitor/browser is only available in the iOS/Android app
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const browserModule = await import('@capacitor/browser' as any) as { Browser: CapacitorBrowser };
      await browserModule.Browser.open({ url });
    } catch {
      // Fallback if Browser plugin isn't available
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * Navigate to internal URL using router
 * Avoids target="_blank" which escapes WebView on mobile
 */
export function navigateInternal(url: string, routerPush: (url: string) => void): void {
  routerPush(url);
}

/**
 * Handle a link click with appropriate navigation
 * - Internal links: Uses router.push (stays in WebView on Capacitor)
 * - External links: Uses Browser.open on mobile (Safari View Controller)
 */
export async function handleLinkNavigation(
  url: string,
  routerPush: (url: string) => void
): Promise<void> {
  if (isInternalUrl(url)) {
    routerPush(url);
  } else {
    await openExternalUrl(url);
  }
}

/**
 * Custom navigation event type for TipTap mentions and other vanilla DOM components
 */
export interface NavigationEventDetail {
  href: string;
}

/**
 * Subscribe to internal navigation events from TipTap mentions
 * Returns cleanup function to unsubscribe
 */
export function subscribeToNavigationEvents(
  routerPush: (url: string) => void
): () => void {
  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<NavigationEventDetail>;
    const { href } = customEvent.detail;
    if (href) {
      routerPush(href);
    }
  };

  document.addEventListener('pagespace:navigate', handler);

  return () => {
    document.removeEventListener('pagespace:navigate', handler);
  };
}
