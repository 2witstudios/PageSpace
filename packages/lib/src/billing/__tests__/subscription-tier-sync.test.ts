import { describe, expect, it } from 'vitest';
import {
  ENTITLED_SUBSCRIPTION_STATUSES,
  deriveTierFromSubscriptions,
  computeTierDrift,
  isTierDriftRepairable,
} from '../subscription-tier-sync';
import type { SubscriptionTier } from '../subscription-tiers';

const priceTier = (map: Record<string, SubscriptionTier>) =>
  (priceId: string): SubscriptionTier => map[priceId] ?? 'free';

const KNOWN = priceTier({ price_pro: 'pro', price_founder: 'founder', price_business: 'business' });

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
      deriveTierFromSubscriptions([{ status: 'trialing', stripePriceId: 'price_founder' }], KNOWN),
    ).toEqual({ tier: 'founder', indeterminate: false });
  });

  it('takes the highest-ranked tier across multiple entitled rows', () => {
    const rows = [
      { status: 'active', stripePriceId: 'price_pro' },
      { status: 'trialing', stripePriceId: 'price_business' },
      { status: 'active', stripePriceId: 'price_founder' },
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
    expect(computeTierDrift({ storedTier: 'founder', derived: { tier: 'free', indeterminate: false } })).toEqual({
      drifted: true,
      storedTier: 'founder',
      expectedTier: 'free',
    });
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

describe('isTierDriftRepairable', () => {
  it('is repairable when determinate and the user has a subscription record (e.g. a canceled row)', () => {
    // A canceled/expired subscription still LEAVES A ROW — this is the normal
    // downgrade path, not the unmigrated-legacy-user case below.
    expect(
      isTierDriftRepairable({
        storedTier: 'founder',
        derived: { tier: 'free', indeterminate: false },
        hasAnySubscriptionRecord: true,
      }),
    ).toBe(true);
  });

  it('is NOT repairable when the derivation is indeterminate (unmapped price)', () => {
    expect(
      isTierDriftRepairable({
        storedTier: 'pro',
        derived: { tier: 'free', indeterminate: true },
        hasAnySubscriptionRecord: true,
      }),
    ).toBe(false);
  });

  describe('unmigrated legacy paid user (no subscription record at all)', () => {
    // Regression for a P1 review finding: a non-free stored tier with ZERO
    // subscription rows is exactly the population the retired
    // scripts/sync-legacy-subscriptions.ts existed to migrate (a tier set
    // before a real Stripe subscription backed it, e.g. an old manual/gift
    // grant). The reconciler must NOT auto-repair this downward to free —
    // that would silently revoke a paying customer's entitlements.

    it('is NOT repairable for a non-free stored tier with no subscription record', () => {
      expect(
        isTierDriftRepairable({
          storedTier: 'founder',
          derived: { tier: 'free', indeterminate: false },
          hasAnySubscriptionRecord: false,
        }),
      ).toBe(false);
    });

    it('does not apply the no-record guard to an ALREADY-free stored tier', () => {
      // A free user with no subscriptions row is the ordinary case, not
      // an unmigrated legacy user — nothing to protect here.
      expect(
        isTierDriftRepairable({
          storedTier: 'free',
          derived: { tier: 'free', indeterminate: false },
          hasAnySubscriptionRecord: false,
        }),
      ).toBe(true);
    });

    it('does not apply the no-record guard once a subscription record exists (normal cancel path)', () => {
      expect(
        isTierDriftRepairable({
          storedTier: 'founder',
          derived: { tier: 'free', indeterminate: false },
          hasAnySubscriptionRecord: true,
        }),
      ).toBe(true);
    });
  });
});
