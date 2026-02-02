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
  },
  android: {
    backgroundColor: '#000000',
    allowMixedContent: false,
    useLegacyBridge: false,
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
      style: 'LIGHT', // Light content (icons/text) on dark background
      backgroundColor: '#000000',
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
