import Stripe from 'stripe';

/**
 * Centralized Stripe client instance.
 * Uses lazy initialization to avoid build-time errors when env vars aren't available.
 * All Stripe API calls should use this client to ensure consistent configuration.
 */

let _stripe: Stripe | null = null;

function getStripeClient(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2025-12-15.clover',
    });
  }
  return _stripe;
}

// Proxy defers initialization until first actual use at runtime
export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_, prop) {
    return (getStripeClient() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export { Stripe };
