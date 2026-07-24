import { describe, expect, it } from 'vitest';
import { resolveControlPlaneTier } from '../control-plane-tier';

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
