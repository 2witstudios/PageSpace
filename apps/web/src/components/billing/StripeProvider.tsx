'use client';

import { loadStripe, Stripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import type { StripeElementsOptions } from '@stripe/stripe-js';
import { stripeConfig } from '@/lib/stripe-config';

// Lazy-load Stripe to prevent crashes if key is missing
let stripePromise: Promise<Stripe | null> | null = null;

function getStripe(): Promise<Stripe | null> | null {
  if (!stripePromise && stripeConfig.publishableKey) {
    stripePromise = loadStripe(stripeConfig.publishableKey);
  }
  return stripePromise;
}

interface StripeProviderProps {
  children: React.ReactNode;
  options?: StripeElementsOptions;
}

/**
 * Stripe Elements provider for embedded payment components.
 * Wraps children with Stripe context for PaymentElement, etc.
 *
 * Usage:
 * ```tsx
 * <StripeProvider options={{ clientSecret }}>
 *   <PaymentElement />
 * </StripeProvider>
 * ```
 */
export function StripeProvider({ children, options }: StripeProviderProps) {
  return (
    <Elements stripe={getStripe()} options={options}>
      {children}
    </Elements>
  );
}

/**
 * Hook to get the Stripe promise for manual Stripe.js initialization.
 * Useful when you need Stripe outside of Elements context.
 */
export function useStripePromise() {
  return getStripe();
}
