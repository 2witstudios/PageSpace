'use client';

import { loadStripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import type { StripeElementsOptions } from '@stripe/stripe-js';

// Initialize Stripe outside component to avoid recreating on every render
const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

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
    <Elements stripe={stripePromise} options={options}>
      {children}
    </Elements>
  );
}

/**
 * Hook to get the Stripe promise for manual Stripe.js initialization.
 * Useful when you need Stripe outside of Elements context.
 */
export function useStripePromise() {
  return stripePromise;
}
