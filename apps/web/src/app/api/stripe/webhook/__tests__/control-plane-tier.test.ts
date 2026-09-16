import { describe, expect, it } from 'vitest';
import { isSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { resolveControlPlaneTier, resolveWebhookMetadataTierForControlPlane } from '../control-plane-tier';

describe('resolveControlPlaneTier', () => {
  it('passes through tiers control-plane already recognizes', () => {
    expect(resolveControlPlaneTier('free')).toBe('free');
    expect(resolveControlPlaneTier('pro')).toBe('pro');
    expect(resolveControlPlaneTier('business')).toBe('business');
  });

  it('A-9 the removed founder tier is not a canonical tier the bridge accepts', () => {
    // Regression for #2148 kept in negative form: 'founder' used to need a
    // founder→business remap here; it is now outside the vocabulary entirely.
    expect(isSubscriptionTier('founder')).toBe(false);
  });

  it('is exhaustive over every canonical SubscriptionTier (compile-time via assertNeverTier)', () => {
    // If TIERS ever grows a member this function doesn't handle, the switch's
    // default branch (assertNeverTier) fails tsc, not just this test.
    expect(resolveControlPlaneTier('free')).toBeTruthy();
  });
});

describe('resolveWebhookMetadataTierForControlPlane', () => {
  it('remaps a canonical SaaS tier through resolveControlPlaneTier', () => {
    expect(resolveWebhookMetadataTierForControlPlane('business')).toBe('business');
    expect(resolveWebhookMetadataTierForControlPlane('pro')).toBe('pro');
  });

  it('A-9 passes the retired founder string through UNCHANGED (control-plane rejects it, this bridge does not invent a tier)', () => {
    expect(resolveWebhookMetadataTierForControlPlane('founder')).toBe('founder');
  });

  it('passes a control-plane-only value (enterprise) through UNCHANGED', () => {
    // Regression: an earlier version coerced every non-SaaS value through the
    // SaaS vocabulary first, silently downgrading a paid enterprise tenant to 'pro'.
    expect(resolveWebhookMetadataTierForControlPlane('enterprise')).toBe('enterprise');
  });

  it('passes an unrecognized string through UNCHANGED (control-plane validates it, not this bridge)', () => {
    expect(resolveWebhookMetadataTierForControlPlane('garbage')).toBe('garbage');
  });

  it('defaults to pro when metadata.tier is missing', () => {
    expect(resolveWebhookMetadataTierForControlPlane(undefined)).toBe('pro');
  });

  it('defaults to pro when metadata.tier is an empty string', () => {
    expect(resolveWebhookMetadataTierForControlPlane('')).toBe('pro');
  });
});
