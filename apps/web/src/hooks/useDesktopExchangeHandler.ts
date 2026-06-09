'use client';

import { useEffect } from 'react';
import { isDesktopPlatform } from '@/lib/desktop-auth';

export function buildDesktopExchangeDeepLink(exchangeCode: string, state?: string | null): string {
  const deepLinkUrl = new URL('pagespace://auth-exchange');
  deepLinkUrl.searchParams.set('code', exchangeCode);
  deepLinkUrl.searchParams.set('provider', 'magic-link');
  // Bind the exchange to the desktop instance's auth flow (finding L9): the
  // main process requires this state to match the one it generated, which
  // closes the session-fixation window for the magic-link producer.
  if (state) deepLinkUrl.searchParams.set('state', state);
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

    // Bind the exchange to a flow this desktop instance starts (finding L9): the
    // returned state is forwarded in the deep link so the main process can
    // require an exact match (closing the session-fixation window for this
    // producer). On web (or older desktop builds) beginExchange is absent and
    // we fire without a state — the main process then falls back to its
    // in-progress-flow gate.
    const fire = (state?: string | null) => {
      window.location.href = buildDesktopExchangeDeepLink(code, state);
    };
    const beginExchange = window.electron?.auth?.beginExchange;
    if (beginExchange) {
      beginExchange().then(
        (state) => fire(state),
        () => fire(),
      );
    } else {
      fire();
    }
  }, []);
}
