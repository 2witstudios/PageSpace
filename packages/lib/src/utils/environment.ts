/**
 * Environment Detection Utilities
 * Helper functions to detect runtime environment and safely access environment-specific APIs
 */

/**
 * Check if we're running in Node.js environment
 */
export function isNodeEnvironment(): boolean {
  return typeof process !== 'undefined' && process.versions?.node !== undefined;
}

/**
 * Check if we're running in browser environment
 */
export function isBrowserEnvironment(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Check if we're running in a server-side rendering context
 */
export function isSSREnvironment(): boolean {
  return isNodeEnvironment() && typeof window === 'undefined';
}

/**
 * Safely get Node.js process information
 */
export function getNodeProcessInfo() {
  if (!isNodeEnvironment()) {
    return {
      pid: undefined,
      platform: undefined,
      version: undefined,
      memoryUsage: undefined
    };
  }

  try {
    return {
      pid: process.pid,
      platform: process.platform,
      version: process.version,
      memoryUsage: process.memoryUsage()
    };
  } catch (error) {
    return {
      pid: undefined,
      platform: undefined,
      version: undefined,
      memoryUsage: undefined
    };
  }
}

/**
 * Safely get hostname
 */
export function getSafeHostname(): string {
  if (isBrowserEnvironment()) {
    try {
      return window.location.hostname;
    } catch {
      return 'browser';
    }
  }

  if (isNodeEnvironment()) {
    try {
      const { hostname } = require('os');
      return hostname();
    } catch {
      return 'node';
    }
  }

  return 'unknown';
}

/**
 * Get environment type as string
 */
export function getEnvironmentType(): 'node' | 'browser' | 'ssr' | 'unknown' {
  if (isSSREnvironment()) return 'ssr';
  if (isBrowserEnvironment()) return 'browser';
  if (isNodeEnvironment()) return 'node';
  return 'unknown';
}