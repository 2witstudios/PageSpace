/**
 * Which store sells the user's current paid personal plan. Stripe first when both do
 * (it is the one the web can manage); null when neither entitles a paid plan.
 */
export function resolveBillingProvider(input: {
  stripeEntitled: boolean;
  appleEntitled: boolean;
}): 'stripe' | 'apple' | null {
  if (input.stripeEntitled) return 'stripe';
  if (input.appleEntitled) return 'apple';
  return null;
}
