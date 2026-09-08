'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { isCapacitorApp } from '@/lib/capacitor-bridge';
import { resolveDeepLink } from '@/lib/navigation/deep-links';
import { openExternalUrl } from '@/lib/navigation/app-navigation';

/**
 * Routes universal links into the app.
 *
 * Both halves are required and they are not interchangeable:
 *
 * - **Cold start** — the shell launches, loads `server.url` (`/dashboard`), and
 *   the link is only recoverable from `App.getLaunchUrl()`.
 * - **Warm start** — the app is already running. `Bridge.onNewIntent` (Android)
 *   and the iOS equivalent only *notify plugins*; neither calls `loadUrl`. So
 *   without a listener the WebView simply stays where it was and nothing at all
 *   happens.
 *
 * Navigation goes through the router, never `window.location`: in the iOS shell
 * a top-level location change is handed to Capacitor's `WKNavigationDelegate`,
 * which cancels anything outside `server.url`'s `/dashboard` prefix and opens
 * system Safari, blanking the WebView. `/invite/*` is outside that prefix, so
 * `window.location` would be exactly the wrong tool. A router transition is
 * pushState and never reaches the delegate.
 */
export function DeepLinkHandler() {
  const router = useRouter();

  useEffect(() => {
    if (!isCapacitorApp()) return;

    let mounted = true;
    let cleanup: (() => void) | undefined;

    const handle = (url: string | undefined | null) => {
      if (!mounted || !url) return;
      const target = resolveDeepLink(url);
      if (!target) return;
      if (target.kind === 'route') {
        router.push(target.path);
        return;
      }
      // Claimed by the app but not routable here. Handing it to the browser
      // keeps a half-configured AASA from turning a working link into a dead
      // one.
      void openExternalUrl(target.url);
    };

    const setup = async () => {
      try {
        const { App } = await import('@capacitor/app');
        if (!mounted) return;

        // Cold start: the launch URL is already spent by the time we mount, so
        // read it before wiring the listener that only covers warm starts.
        const launch = await App.getLaunchUrl();
        handle(launch?.url);

        const listener = await App.addListener('appUrlOpen', ({ url }) => handle(url));
        if (!mounted) {
          listener.remove();
          return;
        }
        cleanup = () => listener.remove();
      } catch {
        // Plugin unavailable — expected on web, and never fatal.
      }
    };

    void setup();

    return () => {
      mounted = false;
      cleanup?.();
    };
  }, [router]);

  return null;
}
