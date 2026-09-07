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
    // Android with no allowNavigation at all, and the apex is listed here to say
    // so out loud rather than to change behaviour.
    //
    // '*.pagespace.ai' is deliberately NOT listed, though the epic's task asked
    // for apex and wildcard both. allowNavigation governs TOP-LEVEL navigations
    // only — subresources from assets.pagespace.ai and friends are unaffected —
    // and the shell loads pagespace.ai and stays there, so the wildcard buys no
    // navigation we can point at while granting the native plugin bridge (see
    // below) to every pagespace.ai subdomain that exists or ever will, tenant
    // hosts included. Least privilege wins over the parity.
    //
    // If a real subdomain navigation ever needs allowing, add that HOST, not the
    // wildcard — and if the wildcard truly is wanted, the apex must stay listed
    // beside it, because one mask cannot cover both: HostMask.Simple.matches()
    // bails when `maskSize > 1 && hostSize != maskSize`, so '*.pagespace.ai' (3
    // dot components) does not match 'pagespace.ai' (2).
    //
    // Deliberately NOT listed here: accounts.google.com and appleid.apple.com,
    // which the iOS config does list. On Android an allowNavigation entry is not
    // just a navigation permit — it is a grant of the native plugin bridge.
    // Bridge.setAllowedOriginRules() folds every entry into allowedOriginRules,
    // and MessageHandler passes that set straight to
    // WebViewCompat.addWebMessageListener(webView, "androidBridge", ...). Any
    // main-frame document from a listed origin can therefore call
    // androidBridge.postMessage(), which reaches Bridge.callPluginMethod() and
    // every registered plugin — including PageSpaceKeychain, the
    // EncryptedSharedPreferences store. Handing that to a third-party consent
    // page to make a broken OAuth fallback fail more visibly is not a trade worth
    // making; the provider pages belong in a Custom Tab with a bound callback,
    // which is the native auth phase's job.
    //
    // (The same two hosts in apps/ios/capacitor.config.ts are worse, not better:
    // iOS registers the bridge as a WKUserScript with forMainFrameOnly: true and
    // NO origin scoping, so it applies to every main-frame document the WebView
    // loads. That is shipped behaviour and a separate change.)
    //
    // What stays is the app's own origin, and that is the point: every host added
    // here is a host handed the native bridge, so this list should only ever grow
    // for a navigation someone can name.
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
