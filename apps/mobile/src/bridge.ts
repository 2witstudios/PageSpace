/**
 * PageSpace Mobile Bridge
 *
 * This module provides a bridge between the Capacitor native layer
 * and the PageSpace web app, mirroring the Electron API pattern.
 *
 * It exposes `window.mobile` with the same interface structure as
 * `window.electron` for consistency.
 */

import { App, type URLOpenListenerEvent } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { Keyboard } from '@capacitor/keyboard';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { Capacitor } from '@capacitor/core';

// Session storage keys
const AUTH_SESSION_KEY = 'auth-session';

interface StoredAuthSession {
  accessToken: string;
  refreshToken: string;
  csrfToken?: string | null;
  deviceToken?: string | null;
}

interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  userAgent: string;
}

// Deep link callback storage
let deepLinkCallback: ((url: string) => void) | null = null;

/**
 * Initialize the mobile bridge and expose it on window.mobile
 */
export async function initializeMobileBridge(): Promise<void> {
  // Set up deep link listener
  await App.addListener('appUrlOpen', (event: URLOpenListenerEvent) => {
    if (deepLinkCallback && event.url) {
      deepLinkCallback(event.url);
    }
  });

  // Configure status bar
  if (Capacitor.isNativePlatform()) {
    try {
      await StatusBar.setStyle({ style: Style.Dark });
      await StatusBar.setOverlaysWebView({ overlay: false });
    } catch (e) {
      console.warn('StatusBar configuration failed:', e);
    }
  }

  // Configure keyboard behavior
  if (Capacitor.isNativePlatform()) {
    try {
      await Keyboard.setResizeMode({ mode: 'body' as any });
    } catch (e) {
      console.warn('Keyboard configuration failed:', e);
    }
  }

  // Expose the mobile API on window
  (window as any).mobile = {
    // Platform information
    platform: Capacitor.getPlatform(), // 'ios' | 'android' | 'web'
    isNative: Capacitor.isNativePlatform(),
    version: '1.0.0', // TODO: Get from native

    // Deep link handling
    onDeepLink: (callback: (url: string) => void) => {
      deepLinkCallback = callback;
    },

    // Authentication (mirrors Electron's window.electron.auth)
    auth: {
      /**
       * Get the current JWT access token
       */
      getJWT: async (): Promise<string | null> => {
        try {
          const session = await getMobileAuth().getSession();
          return session?.accessToken ?? null;
        } catch (e) {
          console.error('Failed to get JWT:', e);
          return null;
        }
      },

      /**
       * Get the full auth session
       */
      getSession: async (): Promise<StoredAuthSession | null> => {
        try {
          // @aparajita/capacitor-secure-storage uses simpler API: get(key)
          const value = await SecureStorage.get(AUTH_SESSION_KEY);
          if (!value) return null;
          // The plugin auto-parses JSON, but we stored as string
          if (typeof value === 'string') {
            return JSON.parse(value) as StoredAuthSession;
          }
          return value as StoredAuthSession;
        } catch (e) {
          console.error('Failed to get session:', e);
          return null;
        }
      },

      /**
       * Store auth session securely
       */
      storeSession: async (session: StoredAuthSession): Promise<{ success: boolean }> => {
        try {
          // @aparajita/capacitor-secure-storage: set(key, data)
          await SecureStorage.set(AUTH_SESSION_KEY, JSON.stringify(session));
          return { success: true };
        } catch (e) {
          console.error('Failed to store session:', e);
          return { success: false };
        }
      },

      /**
       * Clear all auth data
       */
      clearAuth: async (): Promise<void> => {
        try {
          // @aparajita/capacitor-secure-storage: remove(key)
          await SecureStorage.remove(AUTH_SESSION_KEY);
        } catch (e) {
          console.error('Failed to clear auth:', e);
        }
      },

      /**
       * Get device information for auth
       */
      getDeviceInfo: async (): Promise<DeviceInfo> => {
        const platform = Capacitor.getPlatform();
        return {
          deviceId: await getDeviceId(),
          deviceName: platform === 'ios' ? 'iPhone' : platform === 'android' ? 'Android' : 'Mobile',
          platform,
          appVersion: '1.0.0', // TODO: Get from native config
          userAgent: navigator.userAgent,
        };
      },
    },

    // App lifecycle
    app: {
      /**
       * Add listener for app state changes
       */
      onStateChange: (callback: (state: { isActive: boolean }) => void) => {
        App.addListener('appStateChange', callback);
      },

      /**
       * Add listener for back button (Android)
       */
      onBackButton: (callback: () => void) => {
        App.addListener('backButton', callback);
      },

      /**
       * Exit the app (Android only)
       */
      exitApp: () => {
        App.exitApp();
      },
    },

    // Keyboard handling
    keyboard: {
      /**
       * Add listener for keyboard show
       */
      onShow: (callback: (info: { keyboardHeight: number }) => void) => {
        Keyboard.addListener('keyboardWillShow', callback);
      },

      /**
       * Add listener for keyboard hide
       */
      onHide: (callback: () => void) => {
        Keyboard.addListener('keyboardWillHide', callback);
      },

      /**
       * Hide the keyboard
       */
      hide: () => {
        Keyboard.hide();
      },
    },

    // Simple preferences storage (non-sensitive data)
    preferences: {
      get: async (key: string): Promise<string | null> => {
        const { value } = await Preferences.get({ key });
        return value;
      },
      set: async (key: string, value: string): Promise<void> => {
        await Preferences.set({ key, value });
      },
      remove: async (key: string): Promise<void> => {
        await Preferences.remove({ key });
      },
    },

    // Mobile flag for feature detection
    isMobile: true,
  };

  console.log('[PageSpace Mobile] Bridge initialized');
}

/**
 * Get a unique device identifier
 * Falls back to a generated UUID stored in preferences
 */
async function getDeviceId(): Promise<string> {
  const DEVICE_ID_KEY = 'device-id';

  try {
    const { value } = await Preferences.get({ key: DEVICE_ID_KEY });
    if (value) return value;

    // Generate a new device ID
    const newId = crypto.randomUUID();
    await Preferences.set({ key: DEVICE_ID_KEY, value: newId });
    return newId;
  } catch (e) {
    // Fallback to a random ID (won't persist)
    return crypto.randomUUID();
  }
}

/**
 * Helper to get mobile auth API
 */
function getMobileAuth() {
  return (window as any).mobile?.auth;
}

// Type definitions for the exposed API
export interface MobileAPI {
  platform: 'ios' | 'android' | 'web';
  isNative: boolean;
  version: string;
  onDeepLink: (callback: (url: string) => void) => void;
  auth: {
    getJWT: () => Promise<string | null>;
    getSession: () => Promise<StoredAuthSession | null>;
    storeSession: (session: StoredAuthSession) => Promise<{ success: boolean }>;
    clearAuth: () => Promise<void>;
    getDeviceInfo: () => Promise<DeviceInfo>;
  };
  app: {
    onStateChange: (callback: (state: { isActive: boolean }) => void) => void;
    onBackButton: (callback: () => void) => void;
    exitApp: () => void;
  };
  keyboard: {
    onShow: (callback: (info: { keyboardHeight: number }) => void) => void;
    onHide: (callback: () => void) => void;
    hide: () => void;
  };
  preferences: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
    remove: (key: string) => Promise<void>;
  };
  isMobile: true;
}

declare global {
  interface Window {
    mobile: MobileAPI;
    isMobile?: boolean;
  }
}
