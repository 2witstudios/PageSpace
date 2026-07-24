import { describe, expect, it } from 'vitest';
import { resolveControlPlaneTier, resolveWebhookMetadataTierForControlPlane } from '../control-plane-tier';

describe('resolveControlPlaneTier', () => {
  it('passes through tiers control-plane already recognizes', () => {
    expect(resolveControlPlaneTier('free')).toBe('free');
    expect(resolveControlPlaneTier('pro')).toBe('pro');
    expect(resolveControlPlaneTier('business')).toBe('business');
  });

  it('maps founder to the closest control-plane tier instead of failing validation', () => {
    // Regression for #2148: control-plane's VALID_TIERS has no 'founder' —
    // forwarding the raw SaaS tier string fails tenant-validation.ts.
    expect(resolveControlPlaneTier('founder')).toBe('business');
  });

  it('is exhaustive over every canonical SubscriptionTier (compile-time via assertNeverTier)', () => {
    // If TIERS ever grows a member this function doesn't handle, the switch's
    // default branch (assertNeverTier) fails tsc, not just this test.
    expect(resolveControlPlaneTier('free')).toBeTruthy();
  });
});

describe('resolveWebhookMetadataTierForControlPlane', () => {
  it('remaps a canonical SaaS tier through resolveControlPlaneTier', () => {
    expect(resolveWebhookMetadataTierForControlPlane('founder')).toBe('business');
    expect(resolveWebhookMetadataTierForControlPlane('pro')).toBe('pro');
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
