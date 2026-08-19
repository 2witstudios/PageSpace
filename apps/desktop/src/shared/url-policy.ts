/**
 * Shared URL policy for the desktop shell.
 *
 * Pure and dependency-free so both the main process and its tests can use it.
 */

/** Where the app lives when nothing is configured. */
export const PRODUCTION_ORIGIN = 'https://pagespace.ai';
export const DEVELOPMENT_ORIGIN = 'http://localhost:3000';

/**
 * Force https on anything that is not a loopback address.
 *
 * Deliberately a substring test on the raw string rather than a parsed hostname
 * check: it is the rule the shell has always applied, it runs before the value
 * is known to be parseable, and tightening it would silently start rejecting
 * loopback configurations that work today.
 */
export function upgradeInsecureUrl(value: string): string {
  if (value.includes('localhost') || value.includes('127.0.0.1')) return value;
  return value.replace(/^http:/, 'https:');
}
