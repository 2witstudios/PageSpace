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
  },
  ios: {
    scheme: 'PageSpace',
    contentInset: 'never',
    backgroundColor: '#000000',
    preferredContentMode: 'desktop',
    allowsLinkPreview: false,
    scrollEnabled: true,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 0,
      backgroundColor: '#000000',
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
