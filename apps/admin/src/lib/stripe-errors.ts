/**
 * User-friendly error message mapping for Stripe API errors.
 * Maps technical Stripe error messages to user-friendly versions.
 */

const STRIPE_ERROR_MAP: Record<string, string> = {
  // Promo code restrictions
  'prior transactions': 'This promotion code is only available for new customers.',
  'first time': 'This promotion code is only available for new customers.',
  'has already been redeemed': 'This promotion code has already been used.',
  'not valid for the products': 'This promotion code is not valid for this plan.',
  'promotion code has expired': 'This promotion code has expired.',
  'maximum redemptions': 'This promotion code has reached its maximum uses.',
  // Customer errors
  'no such customer': 'Unable to process payment. Please try again.',
  'customer was deleted': 'Unable to process payment. Please try again.',
  // Payment errors
  'card was declined': 'Your card was declined. Please try a different payment method.',
  'insufficient funds': 'Your card has insufficient funds.',
  'expired card': 'Your card has expired. Please use a different card.',
};

/**
 * Convert a Stripe error to a user-friendly message.
 * Falls back to a generic message for unknown errors.
 */
export function getUserFriendlyStripeError(error: Error): string {
  const message = error.message.toLowerCase();

  for (const [pattern, friendlyMessage] of Object.entries(STRIPE_ERROR_MAP)) {
    if (message.includes(pattern)) {
      return friendlyMessage;
    }
  }

  // Fallback to generic message for unknown errors
  return 'Unable to process this request. Please try again.';
}
