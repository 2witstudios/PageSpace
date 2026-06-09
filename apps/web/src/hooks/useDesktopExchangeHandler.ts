'use client';

import { useEffect } from 'react';
import { isDesktopPlatform } from '@/lib/desktop-auth';

export function buildDesktopExchangeDeepLink(exchangeCode: string): string {
  const deepLinkUrl = new URL('pagespace://auth-exchange');
  deepLinkUrl.searchParams.set('code', exchangeCode);
  deepLinkUrl.searchParams.set('provider', 'magic-link');
  return deepLinkUrl.toString();
}

/**
 * Extract desktopExchange param from search string.
 * Returns the exchange code if present and on desktop, null otherwise.
 */
export function extractDesktopExchangeCode(search = typeof window !== 'undefined' ? window.location.search : ''): string | null {
  const params = new URLSearchParams(search);
  const exchangeCode = params.get('desktopExchange');
  if (!exchangeCode || !isDesktopPlatform()) return null;
  return exchangeCode;
}

/**
 * Detects a `desktopExchange` URL param (set by magic-link verify for desktop)
 * and triggers the pagespace:// deep link to hand tokens off to the Electron app.
 *
 * The web session (cookies) is already established, so the deep link is
 * supplementary. If it fails, the user still has a working session.
 */
export function useDesktopExchangeHandler() {
  useEffect(() => {
    const code = extractDesktopExchangeCode();
    if (!code) return;

    // Clean up the param from the URL
    const params = new URLSearchParams(window.location.search);
    params.delete('desktopExchange');
    const newUrl = new URL(window.location.href);
    newUrl.search = params.toString();
    window.history.replaceState({}, '', newUrl.toString());

    // Bind the exchange to a flow this desktop instance starts (finding L9) so
    // the main process accepts the returning deep link. The deep link is only
    // fired after the flow is registered; on web (or older desktop builds) the
    // begin call is a no-op and we fall through to firing the deep link.
    const fire = () => {
      window.location.href = buildDesktopExchangeDeepLink(code);
    };
    const beginExchange = window.electron?.auth?.beginExchange;
    if (beginExchange) {
      void beginExchange().finally(fire);
    } else {
      fire();
    }
  }, []);
}
