import InAppSpy from 'inapp-spy';
import { isCapacitorApp } from '@/lib/capacitor-bridge';

const NOT_IN_APP = { isInApp: false, appName: undefined } as const;

/**
 * Is this page running inside a third-party in-app browser (Instagram,
 * Facebook, Telegram, …) where Google's web OAuth is refused?
 *
 * Our own Capacitor shell is a WKWebView too, so `inapp-spy` flags it — but it
 * is not a third-party browser: Google sign-in there goes through the native
 * `@capgo/capacitor-social-login` plugin, never the blocked web flow. Answer
 * "no" for the shell before asking `inapp-spy`, so genuine in-app browsers
 * keep their warning and the app never tells users a working button is
 * blocked. Platform knowledge stays in `capacitor-bridge`, the one sanctioned
 * reader of `window.Capacitor`.
 */
export function detectInAppBrowser(): { isInApp: boolean; appName: string | undefined } {
  if (typeof navigator === 'undefined') return NOT_IN_APP;
  if (isCapacitorApp()) return NOT_IN_APP;
  // Don't pass ua — lets inapp-spy use all detection methods including
  // non-UA signals (e.g. Telegram detects via window.TelegramWebviewProxy)
  return InAppSpy();
}

export function getPreferredBrowserName(): 'Safari' | 'Chrome' | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return 'Safari';
  if (/android/i.test(ua)) return 'Chrome';
  return null;
}
