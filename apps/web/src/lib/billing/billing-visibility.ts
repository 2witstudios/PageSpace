/**
 * Returns the redirect destination when a user on iOS tries to access billing pages.
 */
export function getBillingRedirect(): string {
  return '/settings';
}
