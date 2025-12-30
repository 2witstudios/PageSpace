import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pagespace.app',
  appName: 'PageSpace',
  // Web directory for local builds (used during cap sync)
  // When using server.url, this just needs to exist
  webDir: 'www',

  // Load the remote PageSpace server
  server: {
    // Production URL - change to localhost:3000 for development
    url: process.env.PAGESPACE_URL || 'https://pagespace.ai',
    // Don't clear cookies on app launch (preserves auth)
    cleartext: false,
    // Allow navigation to the app domain
    allowNavigation: ['pagespace.ai', '*.pagespace.ai'],
  },

  // iOS-specific configuration
  ios: {
    // Use WKWebView (modern, required for App Store)
    contentInset: 'automatic',
    // Allow inline media playback
    allowsLinkPreview: true,
    // Handle safe areas properly
    preferredContentMode: 'mobile',
  },

  // Android-specific configuration
  android: {
    // Allow mixed content for development (disable in production)
    allowMixedContent: false,
    // Capture all navigation (for deep links)
    captureInput: true,
    // Use hardware back button
    hardwareBackButton: true,
  },

  plugins: {
    // Keyboard plugin config
    Keyboard: {
      // Resize content when keyboard appears
      resize: 'body',
      // iOS-specific keyboard behavior
      resizeOnFullScreen: true,
    },

    // Status bar config
    StatusBar: {
      // Use dark content (dark icons) on light backgrounds
      style: 'DARK',
      // Don't overlay content
      overlaysWebView: false,
    },

    // Deep link handling
    App: {
      // URL scheme for deep links (pagespace://)
      // Configured in native projects
    },
  },
};

export default config;
