/**
 * PageSpace iOS - Capacitor Native Bridge
 *
 * This module provides native iOS functionality for the PageSpace web app
 * when running inside the Capacitor wrapper.
 */

// Auth & Session Management
export {
  getOrCreateDeviceId,
  storeSession,
  getSession,
  getSessionToken,
  clearSession,
  storeCsrfToken,
  getCsrfToken,
  isAuthenticated,
  type StoredAuthSession,
} from './auth-bridge';

// UI Configuration
export {
  setupIOSUI,
  setStatusBarStyle,
  cleanupKeyboardListeners,
} from './ui-setup';

// App Lifecycle
export {
  setupAppLifecycle,
  setDeepLinkHandler,
  hideSplashScreen,
} from './lifecycle';

// Re-export Capacitor utilities for convenience
export { Capacitor } from '@capacitor/core';
export { App } from '@capacitor/app';
export { Preferences } from '@capacitor/preferences';
export { Browser } from '@capacitor/browser';

import { setupIOSUI } from './ui-setup';
import { setupAppLifecycle } from './lifecycle';

/**
 * Initialize the iOS native bridge.
 * Call this early in your app's startup.
 */
export async function initializeIOSBridge(): Promise<void> {
  await setupIOSUI();
  setupAppLifecycle();

  console.log('[PageSpace iOS] Native bridge initialized');
}
