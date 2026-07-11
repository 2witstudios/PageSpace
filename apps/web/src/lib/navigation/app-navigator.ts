type Navigate = (path: string) => void;

let navigator: Navigate | null = null;

/**
 * Registers Next's client router so non-React modules can navigate through it.
 * Called once from useAuth().
 */
export function setAppNavigator(navigate: Navigate | null): void {
  navigator = navigate;
}

/**
 * Navigates to an in-app route without a document load.
 *
 * `window.location` hands the URL to Capacitor's WKNavigationDelegate, which
 * cancels any top-level navigation outside the path prefix of `server.url`
 * (`https://pagespace.ai/dashboard`) and opens it in system Safari instead —
 * leaving the iOS WebView blank. A router transition is pushState and never
 * reaches the delegate at all, which is why the app behaves normally once
 * loaded. Use this for every in-app target; leave genuinely external URLs
 * (Stripe, OAuth providers, deep links) on `window.location`.
 *
 * The `window.location` fallback only fires before useAuth() has mounted, when
 * there is no router to route through anyway.
 */
export function navigateInApp(path: string): void {
  if (navigator) {
    navigator(path);
    return;
  }

  if (typeof window !== 'undefined') {
    window.location.assign(path);
  }
}
