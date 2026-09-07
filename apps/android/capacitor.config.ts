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
    // Every host listed here is handed the NATIVE PLUGIN BRIDGE, not merely
    // permission to navigate. Bridge.setAllowedOriginRules() folds each entry
    // into allowedOriginRules, which MessageHandler passes to
    // addWebMessageListener(webView, "androidBridge", ...), and from there
    // postMessage reaches Bridge.callPluginMethod() and every registered plugin
    // — PageSpaceKeychain over EncryptedSharedPreferences included. So: add a
    // host only for a top-level navigation someone can name, never a third-party
    // page, and never a wildcard.
    //
    // The apex alone is behaviourally a no-op: Bridge.launchIntent() compares
    // host and scheme only, so every pagespace.ai path already stays in the
    // WebView. It is listed to state the app's own origin rather than leave it
    // implicit. If a wildcard is ever genuinely needed, the apex must stay beside
    // it — HostMask.Simple.matches() bails when `maskSize > 1 && hostSize !=
    // maskSize`, so '*.pagespace.ai' (3 dot components) never matches
    // 'pagespace.ai' (2).
    //
    // Why this diverges from apps/ios/capacitor.config.ts — which lists a
    // wildcard and both OAuth provider hosts — is in apps/android/README.md
    // under "Why this config is not a copy of the iOS one".
    allowNavigation: ['pagespace.ai'],
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
