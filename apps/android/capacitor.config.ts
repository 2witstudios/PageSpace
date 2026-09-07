import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'ai.pagespace.android',
  appName: 'PageSpace',
  webDir: './public', // Fallback for offline scenarios; app loads from server.url
  server: {
    // Production: load directly to dashboard, bypassing landing page
    url: 'https://pagespace.ai/dashboard',
    cleartext: false,
    // NOT the same trap as iOS. iOS bricked (PR #2010) because
    // WebViewDelegationHandler.swift falls back to a raw string-prefix test of
    // the target URL against server.url — which carries the `/dashboard` path —
    // so any top-level navigation to another path failed it. Android's
    // equivalent, Bridge.launchIntent(), compares only host and scheme:
    //
    //   !(appUri.getHost().equals(url.getHost()) && url.getScheme().equals(appUri.getScheme()))
    //     && !appAllowNavigationMask.matches(url.getHost())
    //
    // `https://pagespace.ai/signin` therefore already stays in the WebView on
    // Android with no allowNavigation at all. This list is here for the hosts
    // that are NOT pagespace.ai, where Android does hand the URL to the system
    // browser via ACTION_VIEW exactly as iOS hands it to Safari.
    //
    // The apex must still be listed separately: HostMask.Simple.matches() bails
    // when `maskSize > 1 && hostSize != maskSize`, so '*.pagespace.ai' (3 dot
    // components) does not match 'pagespace.ai' (2).
    //
    // Google/Apple are deliberate but imperfect, and the reasoning differs from
    // iOS in one important way. On iOS the web OAuth fallback should never fire,
    // because sign-in goes through the native plugin. On Android it is currently
    // the ONLY path: isNativeGoogleAuthAvailable() in ios-google-auth.ts is
    // `isCapacitorApp() && getPlatform() === 'ios'`, so until the epic's native
    // auth phase generalizes it, Android takes the browser fallback every time.
    //
    // Both outcomes are broken, and this picks the diagnosable one. Allowlisted,
    // the consent screen loads in the WebView and Google answers
    // `disallowed_useragent` — a visible failure. Omitted, it goes to Chrome,
    // where a successful sign-in drops the cookie in the WRONG cookie jar and the
    // app stays silently logged out. Nobody is hitting either today: there is no
    // shipped Android build (versionCode is still 1), and native auth should land
    // before there is one. The real fix is native sign-in, not this list.
    //
    // Android-only caveat: Bridge.setAllowedOriginRules() also adds these hosts
    // to WebViewLocalServer's `authorities`. That only changes behaviour while
    // Capacitor's JS injector is still live — i.e. on a WebView too old for
    // WebViewFeature.DOCUMENT_START_SCRIPT (pre-WebView 83), where a top-level
    // HTML GET to these hosts would be proxied through HttpURLConnection. On any
    // current WebView the injector is null and shouldInterceptRequest returns
    // null, leaving the native network stack in charge.
    allowNavigation: ['pagespace.ai', '*.pagespace.ai', 'accounts.google.com', 'appleid.apple.com'],
    // Bundled retry screen (apps/android/public/index.html). Android reads this
    // in BridgeWebViewClient.onReceivedError/onReceivedHttpError for main-frame
    // requests and loads Bridge.getErrorUrl() — `https://localhost/index.html`,
    // served from the bundled assets. Without it a failed load leaves the
    // WebView showing its own error page.
    errorPath: 'index.html',
  },
  android: {
    backgroundColor: '#0f0f0f',
    allowMixedContent: false,
    useLegacyBridge: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 0,
      backgroundColor: '#0f0f0f',
      showSpinner: false,
    },
    Keyboard: {
      resize: KeyboardResize.None,
      resizeOnFullScreen: true,
    },
    StatusBar: {
      style: 'LIGHT', // Light content (icons/text) on dark background
      backgroundColor: '#0f0f0f',
    },
    SocialLogin: {
      google: {
        // You'll need to add your Android client ID from Google Cloud Console
        androidClientId: '636969838408-s5s3ts6nubc6c29ur81o2ipf6tmu9gqq.apps.googleusercontent.com',
      },
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
