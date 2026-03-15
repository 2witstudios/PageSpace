import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @pagespace/lib/server loggers ────────────────────────────────────────
// vi.mock is hoisted — use inline vi.fn() in factory, not outer variables
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

// ── Import under test ─────────────────────────────────────────────────────────
import {
  STRIPE_PRICE_TO_TIER,
  LEGACY_PRICE_AMOUNTS,
  getTierFromPrice,
} from '../price-config';
import { loggers } from '@pagespace/lib/server';

const mockWarn = loggers.api.warn as ReturnType<typeof vi.fn>;
const mockError = loggers.api.error as ReturnType<typeof vi.fn>;

describe('stripe/price-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('STRIPE_PRICE_TO_TIER', () => {
    it('should be a non-empty record', () => {
      expect(Object.keys(STRIPE_PRICE_TO_TIER).length).toBeGreaterThan(0);
    });

    it('should map price IDs to valid tiers', () => {
      const validTiers = ['pro', 'founder', 'business'];
      for (const tier of Object.values(STRIPE_PRICE_TO_TIER)) {
        expect(validTiers).toContain(tier);
      }
    });

    it('should contain entries for pro, founder, and business', () => {
      const tiers = Object.values(STRIPE_PRICE_TO_TIER);
      expect(tiers).toContain('pro');
      expect(tiers).toContain('founder');
      expect(tiers).toContain('business');
    });
  });

  describe('LEGACY_PRICE_AMOUNTS', () => {
    it('should map 1500 to pro', () => {
      expect(LEGACY_PRICE_AMOUNTS[1500]).toBe('pro');
    });

    it('should map 2999 to pro (legacy)', () => {
      expect(LEGACY_PRICE_AMOUNTS[2999]).toBe('pro');
    });

    it('should map 5000 to founder', () => {
      expect(LEGACY_PRICE_AMOUNTS[5000]).toBe('founder');
    });

    it('should map 10000 to business', () => {
      expect(LEGACY_PRICE_AMOUNTS[10000]).toBe('business');
    });

    it('should map 19999 to business (legacy)', () => {
      expect(LEGACY_PRICE_AMOUNTS[19999]).toBe('business');
    });
  });

  describe('getTierFromPrice', () => {
    it('should return correct tier for known price ID', () => {
      const [priceId, tier] = Object.entries(STRIPE_PRICE_TO_TIER)[0];
      expect(getTierFromPrice(priceId)).toBe(tier);
    });

    it('should return free for unknown price ID with no amount', () => {
      const result = getTierFromPrice('price_unknown_xyz');
      expect(result).toBe('free');
    });

    it('should log error for unknown price ID with no amount', () => {
      getTierFromPrice('price_unknown_xyz');
      expect(mockError).toHaveBeenCalled();
    });

    it('should fall back to amount-based tier for unknown price ID', () => {
      const result = getTierFromPrice('price_unknown', 1500);
      expect(result).toBe('pro');
    });

    it('should log warning when falling back to amount', () => {
      getTierFromPrice('price_unknown', 5000);
      expect(mockWarn).toHaveBeenCalled();
    });

    it('should return founder for unknown price with amount 5000', () => {
      expect(getTierFromPrice('price_unknown', 5000)).toBe('founder');
    });

    it('should return business for unknown price with amount 10000', () => {
      expect(getTierFromPrice('price_unknown', 10000)).toBe('business');
    });

    it('should return free for unknown price with unrecognized amount', () => {
      const result = getTierFromPrice('price_unknown', 999);
      expect(result).toBe('free');
    });

    it('should prioritize price ID over amount when price ID is known', () => {
      const [priceId, expectedTier] = Object.entries(STRIPE_PRICE_TO_TIER)[0];
      const result = getTierFromPrice(priceId, 99999);
      expect(result).toBe(expectedTier);
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('should handle null amount gracefully', () => {
      const result = getTierFromPrice('price_unknown', null);
      expect(result).toBe('free');
    });

    it('should handle undefined amount gracefully', () => {
      const result = getTierFromPrice('price_unknown', undefined);
      expect(result).toBe('free');
    });
  });
});
