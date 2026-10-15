import { describe, expect, it } from 'vitest';
import {
  TIERS,
  TIER_PLAN_LIMITS,
  isSubscriptionTier,
  toSubscriptionTier,
  toPersonalSubscriptionTier,
  tierRank,
  formatTierBytes,
  isOrgPlanTier,
  personalTiers,
  tierFromConfiguredPrice,
  type SubscriptionTier,
} from '../subscription-tiers';

describe('tierFromConfiguredPrice', () => {
  const prices = { pro: 'price_pro', business: 'price_org_business' };

  it('SEAT-2 (partial) resolves only the configured paid price identities', () => {
    expect(tierFromConfiguredPrice('price_pro', prices)).toBe('pro');
    expect(tierFromConfiguredPrice('price_org_business', prices)).toBe('business');
    for (const priceId of ['price_unknown', 'price_founder', 'price_personal_business', '', 'toString', '__proto__']) {
      expect(tierFromConfiguredPrice(priceId, prices)).toBe('free');
    }
  });

  it('SEAT-2 (partial) an unconfigured or ambiguous price cannot grant entitlements', () => {
    expect(tierFromConfiguredPrice('', { pro: '', business: '' })).toBe('free');
    expect(tierFromConfiguredPrice('price_shared', { pro: 'price_shared', business: 'price_shared' })).toBe('free');
    expect(tierFromConfiguredPrice('price_pro', { pro: 'price_pro', business: '' })).toBe('pro');
  });
});

describe('TIERS', () => {
  it('SEAT-2 (partial) lists Free, Pro, Business in ascending plan order (also the upgrade/downgrade ordering)', () => {
    expect(TIERS).toEqual(['free', 'pro', 'business']);
  });

  it('A-9 no longer contains founder', () => {
    expect((TIERS as readonly string[]).includes('founder')).toBe(false);
    expect(isSubscriptionTier('founder')).toBe(false);
  });
});

describe('isSubscriptionTier', () => {
  it.each(TIERS)('accepts "%s"', (tier) => {
    expect(isSubscriptionTier(tier)).toBe(true);
  });

  it('rejects strings outside the vocabulary', () => {
    expect(isSubscriptionTier('enterprise')).toBe(false);
    expect(isSubscriptionTier('')).toBe(false);
    expect(isSubscriptionTier('Free')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isSubscriptionTier(null)).toBe(false);
    expect(isSubscriptionTier(undefined)).toBe(false);
    expect(isSubscriptionTier(3)).toBe(false);
  });
});

describe('toSubscriptionTier', () => {
  it.each(TIERS)('passes "%s" through', (tier) => {
    expect(toSubscriptionTier(tier)).toBe(tier);
  });

  it('falls back to free for unknown, null, and undefined values', () => {
    expect(toSubscriptionTier('enterprise')).toBe('free');
    expect(toSubscriptionTier('founder')).toBe('free');
    expect(toSubscriptionTier(null)).toBe('free');
    expect(toSubscriptionTier(undefined)).toBe('free');
  });
});

describe('tierRank', () => {
  it('ranks tiers strictly ascending in PLAN_ORDER order', () => {
    const ranks = TIERS.map((t) => tierRank(t));
    expect(ranks).toEqual([0, 1, 2]);
  });
});

describe('TIER_PLAN_LIMITS', () => {
  it('covers every tier and nothing else', () => {
    expect(Object.keys(TIER_PLAN_LIMITS).sort()).toEqual([...TIERS].sort());
  });

  it('pins the canonical enforcement numbers', () => {
    const MB = 1024 * 1024;
    const GB = 1024 * MB;
    expect(TIER_PLAN_LIMITS.free).toMatchObject({
      name: 'Free', priceMonthlyUsd: 0, quotaBytes: 500 * MB, maxFileSize: 50 * MB,
      maxConcurrentUploads: 3, maxFileCount: 100, maxCustomDomains: 0,
      canChooseSubdomain: false, proModels: false,
      isOrgPlan: false, includedSeats: 0, extraSeatUsd: 0,
    });
    expect(TIER_PLAN_LIMITS.pro).toMatchObject({
      name: 'Pro', priceMonthlyUsd: 15, quotaBytes: 10 * GB, maxFileSize: 250 * MB,
      maxConcurrentUploads: 5, maxFileCount: 0, maxCustomDomains: 1,
      canChooseSubdomain: true, proModels: true,
      isOrgPlan: false, includedSeats: 0, extraSeatUsd: 0,
    });
    expect(TIER_PLAN_LIMITS.business).toMatchObject({
      name: 'Business', priceMonthlyUsd: 50, quotaBytes: 50 * GB, maxFileSize: 1 * GB,
      maxConcurrentUploads: 10, maxFileCount: 0, maxCustomDomains: 10,
      canChooseSubdomain: true, proModels: true,
    });
  });

  it('SEAT-2 (partial) Business is the org plan: $50 a month, 5 seats included, $10 per extra seat', () => {
    expect(TIER_PLAN_LIMITS.business).toMatchObject({
      priceMonthlyUsd: 50, isOrgPlan: true, includedSeats: 5, extraSeatUsd: 10,
    });
    expect(isOrgPlanTier('business')).toBe(true);
    expect(isOrgPlanTier('pro')).toBe(false);
    expect(isOrgPlanTier('free')).toBe(false);
  });

  it('SEAT-2 (partial) personal plans never include Business after cutover', () => {
    expect(personalTiers()).toEqual(['free', 'pro']);
  });

  it('limits grow monotonically with tier rank', () => {
    for (let i = 1; i < TIERS.length; i++) {
      const lower = TIER_PLAN_LIMITS[TIERS[i - 1]];
      const higher = TIER_PLAN_LIMITS[TIERS[i]];
      expect(higher.quotaBytes).toBeGreaterThan(lower.quotaBytes);
      expect(higher.maxFileSize).toBeGreaterThan(lower.maxFileSize);
      expect(higher.priceMonthlyUsd).toBeGreaterThan(lower.priceMonthlyUsd);
    }
  });
});

describe('formatTierBytes', () => {
  it('formats whole megabyte and gigabyte values compactly', () => {
    expect(formatTierBytes(500 * 1024 * 1024)).toBe('500MB');
    expect(formatTierBytes(2 * 1024 * 1024 * 1024)).toBe('2GB');
    expect(formatTierBytes(1024 * 1024 * 1024)).toBe('1GB');
  });

  it('supports a separator for marketing copy ("500 MB")', () => {
    expect(formatTierBytes(500 * 1024 * 1024, ' ')).toBe('500 MB');
    expect(formatTierBytes(50 * 1024 * 1024 * 1024, ' ')).toBe('50 GB');
  });

  it('formats sub-GB values in MB even when fractional', () => {
    expect(formatTierBytes(1536 * 1024 * 1024)).toBe('1.5GB');
  });
});

describe('type-level', () => {
  it('SubscriptionTier is the element type of TIERS', () => {
    const t: SubscriptionTier = TIERS[0];
    expect(t).toBe('free');
  });
});

describe('personal subscription vocabulary after cutover', () => {
  it.each(['business', 'founder', 'enterprise', '', null, undefined])('SEAT-2 (partial) refuses retired or organization-only personal tier %s', tier => {
    expect(toPersonalSubscriptionTier(tier)).toBe('free');
  });
  it.each(['free', 'pro'] as const)('keeps supported personal tier %s', tier => {
    expect(toPersonalSubscriptionTier(tier)).toBe(tier);
  });
});
