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
 * Inject platform information into the window object.
 * This allows the web app to detect the platform early.
 */
export function injectPlatformInfo(): void {
  if (typeof window !== 'undefined') {
    (window as Window & { __PAGESPACE_PLATFORM__?: Platform }).__PAGESPACE_PLATFORM__ =
      getPlatform();
  }
}

// Inject platform info on module load
if (typeof window !== 'undefined') {
  injectPlatformInfo();
}
