import { isIOS } from '@/lib/capacitor-bridge';

/**
 * Paths that contain billing/subscription functionality.
 * These should be hidden from iOS Capacitor apps to comply with Apple App Store guidelines.
 */
export const BILLING_PATHS = ['/settings/billing', '/settings/plan'] as const;

/**
 * Determines whether billing UI should be shown.
 * Returns false for iOS Capacitor apps (Apple requires in-app purchases for digital goods).
 *
 * Use this for non-React contexts. For React components, use `useBillingVisibility` hook.
 */
export function shouldShowBilling(): boolean {
  return !isIOS();
}

/**
 * Checks if a given pathname is a billing-related path.
 */
export function isBillingPath(pathname: string): boolean {
  return BILLING_PATHS.some(path => pathname.startsWith(path));
}

/**
 * Returns the redirect destination when a user on iOS tries to access billing pages.
 */
export function getBillingRedirect(): string {
  return '/settings';
}
