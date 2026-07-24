import { describe, expect, it } from 'vitest';
import {
  TIERS,
  PLAN_ORDER,
  TIER_PLAN_LIMITS,
  isSubscriptionTier,
  toSubscriptionTier,
  tierRank,
  formatTierBytes,
  type SubscriptionTier,
} from '../subscription-tiers';

describe('TIERS / PLAN_ORDER', () => {
  it('lists the canonical vocabulary in ascending plan order', () => {
    expect(TIERS).toEqual(['free', 'pro', 'founder', 'business']);
    expect(PLAN_ORDER).toEqual(TIERS);
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
    expect(toSubscriptionTier(null)).toBe('free');
    expect(toSubscriptionTier(undefined)).toBe('free');
  });
});

describe('tierRank', () => {
  it('ranks tiers strictly ascending in PLAN_ORDER order', () => {
    const ranks = TIERS.map((t) => tierRank(t));
    expect(ranks).toEqual([0, 1, 2, 3]);
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
    });
    expect(TIER_PLAN_LIMITS.pro).toMatchObject({
      name: 'Pro', priceMonthlyUsd: 15, quotaBytes: 2 * GB, maxFileSize: 250 * MB,
      maxConcurrentUploads: 5, maxFileCount: 500, maxCustomDomains: 1,
      canChooseSubdomain: true, proModels: true,
    });
    expect(TIER_PLAN_LIMITS.founder).toMatchObject({
      name: 'Founder', priceMonthlyUsd: 50, quotaBytes: 10 * GB, maxFileSize: 500 * MB,
      maxConcurrentUploads: 5, maxFileCount: 500, maxCustomDomains: 3,
      canChooseSubdomain: true, proModels: true,
    });
    expect(TIER_PLAN_LIMITS.business).toMatchObject({
      name: 'Business', priceMonthlyUsd: 100, quotaBytes: 50 * GB, maxFileSize: 1 * GB,
      maxConcurrentUploads: 10, maxFileCount: 5000, maxCustomDomains: 10,
      canChooseSubdomain: true, proModels: true,
    });
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
