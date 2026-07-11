import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'ai.pagespace.ios',
  appName: 'PageSpace',
  webDir: './public', // Fallback for offline scenarios; app loads from server.url
  server: {
    // Production: load directly to dashboard, bypassing landing page
    url: 'https://pagespace.ai/dashboard',
    cleartext: false,
    // Required. With no allowNavigation, Capacitor's allowedNavigationHostnames
    // stays empty and shouldAllowNavigation() is false for *every* host —
    // including pagespace.ai itself. WebViewDelegationHandler.swift:98-116 then
    // falls back to a raw string-prefix test of the target URL against
    // server.url, which carries the `/dashboard` path: any top-level navigation
    // to another path (e.g. the signin redirect) fails it, gets handed to system
    // Safari, and is cancelled in the WebView — leaving no document at all. The
    // host check runs first, so listing our hosts here short-circuits that trap.
    // Google/Apple are here because the web-OAuth fallback navigates to them.
    allowNavigation: ['pagespace.ai', '*.pagespace.ai', 'accounts.google.com', 'appleid.apple.com'],
    // Bundled retry screen (apps/ios/public/index.html) so a failed load renders
    // something actionable instead of an empty view.
    errorPath: 'index.html',
  },
  ios: {
    scheme: 'PageSpace',
    contentInset: 'never',
    // The app's real dark background, not pure black — a WebView holding no
    // document is then distinguishable from a loaded dark-theme app.
    backgroundColor: '#0B0B0B',
    preferredContentMode: 'recommended',
    allowsLinkPreview: false,
    scrollEnabled: true,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 0,
      backgroundColor: '#0B0B0B',
      showSpinner: false,
    },
    Keyboard: {
      resize: KeyboardResize.None,
      resizeOnFullScreen: true,
    },
    StatusBar: {
      style: 'light', // Light content (icons/text) on dark background
      backgroundColor: '#000000',
    },
    SocialLogin: {
      apple: {
        clientId: 'ai.pagespace.ios',
      },
      google: {
        iOSClientId: '636969838408-0jbv7gq9793m0uchdrjlr8v1k6m5lh59.apps.googleusercontent.com',
      },
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
