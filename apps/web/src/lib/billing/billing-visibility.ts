/**
 * Paths that contain billing/subscription functionality.
 * These should be hidden from iOS Capacitor apps to comply with Apple App Store guidelines.
 */
export const BILLING_PATHS = ['/settings/billing', '/settings/plan'] as const;

/**
 * Returns the redirect destination when a user on iOS tries to access billing pages.
 */
export function getBillingRedirect(): string {
  return '/settings';
}
