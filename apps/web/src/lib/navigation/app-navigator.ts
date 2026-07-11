type Navigate = (path: string) => void;

// NOT named `navigator`: that would shadow the DOM global inside this module.
let routerNavigate: Navigate | null = null;

/**
 * Registers Next's client router so non-React modules can navigate through it.
 * Called once from useAuth().
 */
export function setAppNavigator(navigate: Navigate): void {
  routerNavigate = navigate;
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
 * The `window.location` fallback is a backstop, not the expected path: useAuth()
 * registers the `auth:expired` listener and this navigator in the same hook, so the
 * only caller can never fire without a router registered.
 */
export function navigateInApp(path: string): void {
  if (routerNavigate) {
    routerNavigate(path);
    return;
  }

  if (typeof window !== 'undefined') {
    window.location.assign(path);
  }
}
