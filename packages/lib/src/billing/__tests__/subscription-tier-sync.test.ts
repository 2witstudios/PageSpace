import { describe, expect, it } from 'vitest';
import {
  ENTITLED_SUBSCRIPTION_STATUSES,
  deriveTierFromSubscriptions,
  computeTierDrift,
} from '../subscription-tier-sync';
import type { SubscriptionTier } from '../subscription-tiers';

const priceTier = (map: Record<string, SubscriptionTier>) =>
  (priceId: string): SubscriptionTier => map[priceId] ?? 'free';

const KNOWN = priceTier({ price_pro: 'pro', price_business: 'business' });

describe('ENTITLED_SUBSCRIPTION_STATUSES', () => {
  it('matches the webhook entitlement set', () => {
    expect(ENTITLED_SUBSCRIPTION_STATUSES).toEqual(['active', 'trialing']);
  });
});

describe('deriveTierFromSubscriptions', () => {
  it('derives free with no rows at all', () => {
    expect(deriveTierFromSubscriptions([], KNOWN)).toEqual({ tier: 'free', indeterminate: false });
  });

  it('ignores non-entitled rows entirely', () => {
    const rows = [
      { status: 'canceled', stripePriceId: 'price_business' },
      { status: 'past_due', stripePriceId: 'price_pro' },
      { status: 'unpaid', stripePriceId: 'price_founder' },
    ];
    expect(deriveTierFromSubscriptions(rows, KNOWN)).toEqual({ tier: 'free', indeterminate: false });
  });

  it('derives the tier of a single entitled row', () => {
    expect(
      deriveTierFromSubscriptions([{ status: 'active', stripePriceId: 'price_pro' }], KNOWN),
    ).toEqual({ tier: 'pro', indeterminate: false });
  });

  it('treats trialing as entitled', () => {
    expect(
      deriveTierFromSubscriptions([{ status: 'trialing', stripePriceId: 'price_business' }], KNOWN),
    ).toEqual({ tier: 'business', indeterminate: false });
  });

  it('takes the highest-ranked tier across multiple entitled rows', () => {
    const rows = [
      { status: 'active', stripePriceId: 'price_pro' },
      { status: 'trialing', stripePriceId: 'price_business' },
      { status: 'active', stripePriceId: 'price_pro' },
    ];
    expect(deriveTierFromSubscriptions(rows, KNOWN)).toEqual({ tier: 'business', indeterminate: false });
  });

  it('flags indeterminate when an entitled row has an unmapped price', () => {
    const rows = [{ status: 'active', stripePriceId: 'price_legacy_unknown' }];
    expect(deriveTierFromSubscriptions(rows, KNOWN)).toEqual({ tier: 'free', indeterminate: true });
  });

  it('still derives the mapped tier when only SOME entitled rows are unmapped, but stays indeterminate', () => {
    const rows = [
      { status: 'active', stripePriceId: 'price_legacy_unknown' },
      { status: 'active', stripePriceId: 'price_pro' },
    ];
    expect(deriveTierFromSubscriptions(rows, KNOWN)).toEqual({ tier: 'pro', indeterminate: true });
  });

  it('a canceled unmapped row does not cause indeterminacy', () => {
    const rows = [
      { status: 'canceled', stripePriceId: 'price_legacy_unknown' },
      { status: 'active', stripePriceId: 'price_pro' },
    ];
    expect(deriveTierFromSubscriptions(rows, KNOWN)).toEqual({ tier: 'pro', indeterminate: false });
  });
});

describe('computeTierDrift', () => {
  it('reports no drift when stored matches derived', () => {
    expect(computeTierDrift({ storedTier: 'pro', derived: { tier: 'pro', indeterminate: false } })).toEqual({
      drifted: false,
      storedTier: 'pro',
      expectedTier: 'pro',
    });
  });

  it('reports drift when stored and derived mismatch, regardless of indeterminacy', () => {
    expect(computeTierDrift({ storedTier: 'business', derived: { tier: 'free', indeterminate: false } })).toEqual({
      drifted: true,
      storedTier: 'business',
      expectedTier: 'free',
    });
  });

  it('A-9 a stale removed tier resolves from its configured replacement subscription', () => {
    // 'founder' is outside the vocabulary: it coerces to free, so the
    // reconciler repairs the row to what the configured replacement price maps to (pro).
    expect(
      computeTierDrift({
        storedTier: 'founder',
        derived: deriveTierFromSubscriptions([{ status: 'active', stripePriceId: 'price_pro' }], KNOWN),
      }),
    ).toEqual({ drifted: true, storedTier: 'free', expectedTier: 'pro' });
  });

  it('an indeterminate derivation that happens to match stored is not drift', () => {
    expect(computeTierDrift({ storedTier: 'pro', derived: { tier: 'pro', indeterminate: true } })).toEqual({
      drifted: false,
      storedTier: 'pro',
      expectedTier: 'pro',
    });
  });

  it('coerces an unknown stored value to free before comparing', () => {
    expect(computeTierDrift({ storedTier: 'enterprise', derived: { tier: 'free', indeterminate: false } })).toEqual({
      drifted: false,
      storedTier: 'free',
      expectedTier: 'free',
    });
  });
});
