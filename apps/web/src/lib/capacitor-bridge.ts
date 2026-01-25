/**
 * Capacitor Bridge Utilities
 *
 * This module provides utilities for communicating between the web app
 * and the native Capacitor layer. It handles platform detection and
 * provides a safe way to call native functions.
 */

type Platform = 'ios' | 'android' | 'web';

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

/**
 * Check if running in a native Capacitor app.
 */
export function isCapacitorApp(): boolean {
  if (typeof window === 'undefined') return false;
  const capacitor = (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
  return typeof capacitor !== 'undefined' && !!capacitor.isNativePlatform?.();
}

/**
 * Get the current platform.
 */
export function getPlatform(): Platform {
  if (typeof window === 'undefined') return 'web';
  const capacitor = (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!capacitor?.isNativePlatform?.()) return 'web';
  return (capacitor.getPlatform?.() as Platform) || 'web';
}

/**
 * Check if running on iOS (native app).
 */
export function isIOS(): boolean {
  return getPlatform() === 'ios';
}

/**
 * Check if running on Android (native app).
 */
export function isAndroid(): boolean {
  return getPlatform() === 'android';
}

/**
 * Inject platform information into the window object.
 * This allows the web app to detect the platform early.
 */
export function injectPlatformInfo(): void {
  if (typeof window !== 'undefined') {
    (window as Window & { __PAGESPACE_PLATFORM__?: Platform }).__PAGESPACE_PLATFORM__ =
      getPlatform();
  }
}

/**
 * Get platform info from window (useful before React hydration).
 */
export function getInjectedPlatform(): Platform {
  if (typeof window === 'undefined') return 'web';
  return (
    (window as Window & { __PAGESPACE_PLATFORM__?: Platform }).__PAGESPACE_PLATFORM__ || 'web'
  );
}

/**
 * Safe wrapper to call native Capacitor functions.
 * Returns undefined if not in native context.
 */
export async function callNative<T>(
  fn: () => Promise<T>
): Promise<T | undefined> {
  if (!isCapacitorApp()) return undefined;
  try {
    return await fn();
  } catch (error) {
    console.warn('[Capacitor Bridge] Native call failed:', error);
    return undefined;
  }
}

// Inject platform info on module load
if (typeof window !== 'undefined') {
  injectPlatformInfo();
}
