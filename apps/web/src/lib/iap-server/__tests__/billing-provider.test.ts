import { describe, it, expect } from 'vitest';
import { resolveBillingProvider } from '../billing-provider';

describe('resolveBillingProvider', () => {
  it('names the store that sells the current plan', () => {
    expect(resolveBillingProvider({ stripeEntitled: true, appleEntitled: false })).toBe('stripe');
    expect(resolveBillingProvider({ stripeEntitled: false, appleEntitled: true })).toBe('apple');
  });

  it('prefers Stripe when both do — the store the web can manage', () => {
    expect(resolveBillingProvider({ stripeEntitled: true, appleEntitled: true })).toBe('stripe');
  });

  it('is null when no store entitles a paid plan', () => {
    expect(resolveBillingProvider({ stripeEntitled: false, appleEntitled: false })).toBeNull();
  });
});
