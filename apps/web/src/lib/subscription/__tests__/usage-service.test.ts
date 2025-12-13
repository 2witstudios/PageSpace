import { describe, it, expect } from 'vitest';
import { getUsageLimits } from '../usage-service';

// Note: incrementUsage, getCurrentUsage, and getUserUsageSummary require database
// and Redis mocking. We test those in integration tests. Here we test the pure function.

describe('Usage Service', () => {
  describe('getUsageLimits()', () => {
    describe('standard provider type', () => {
      it('should return 50 for free tier', () => {
        expect(getUsageLimits('free', 'standard')).toBe(50);
      });

      it('should return 200 for pro tier', () => {
        expect(getUsageLimits('pro', 'standard')).toBe(200);
      });

      it('should return 500 for founder tier', () => {
        expect(getUsageLimits('founder', 'standard')).toBe(500);
      });

      it('should return 1000 for business tier', () => {
        expect(getUsageLimits('business', 'standard')).toBe(1000);
      });

      it('should return 50 (free tier default) for unknown tier', () => {
        expect(getUsageLimits('unknown', 'standard')).toBe(50);
      });
    });

    describe('pro provider type', () => {
      it('should return 0 for free tier (no access)', () => {
        expect(getUsageLimits('free', 'pro')).toBe(0);
      });

      it('should return 50 for pro tier', () => {
        expect(getUsageLimits('pro', 'pro')).toBe(50);
      });

      it('should return 100 for founder tier', () => {
        expect(getUsageLimits('founder', 'pro')).toBe(100);
      });

      it('should return 500 for business tier', () => {
        expect(getUsageLimits('business', 'pro')).toBe(500);
      });

      it('should return 0 (no access) for unknown tier', () => {
        expect(getUsageLimits('unknown', 'pro')).toBe(0);
      });
    });

    describe('unknown provider type', () => {
      it('should return 0 for any tier with unknown provider', () => {
        expect(getUsageLimits('free', 'unknown' as 'standard' | 'pro')).toBe(0);
        expect(getUsageLimits('pro', 'unknown' as 'standard' | 'pro')).toBe(0);
        expect(getUsageLimits('business', 'unknown' as 'standard' | 'pro')).toBe(0);
      });
    });
  });

  describe('Usage Limit Business Rules', () => {
    it('should give free tier users no access to pro AI', () => {
      // Business rule: Free users cannot use pro AI models
      const proLimit = getUsageLimits('free', 'pro');
      expect(proLimit).toBe(0);
    });

    it('should give paying users access to pro AI', () => {
      // Business rule: All paid tiers have pro AI access
      expect(getUsageLimits('pro', 'pro')).toBeGreaterThan(0);
      expect(getUsageLimits('founder', 'pro')).toBeGreaterThan(0);
      expect(getUsageLimits('business', 'pro')).toBeGreaterThan(0);
    });

    it('should have increasing standard limits with tier', () => {
      // Business rule: Higher tiers get more standard AI calls
      const free = getUsageLimits('free', 'standard');
      const pro = getUsageLimits('pro', 'standard');
      const founder = getUsageLimits('founder', 'standard');
      const business = getUsageLimits('business', 'standard');

      expect(pro).toBeGreaterThan(free);
      expect(founder).toBeGreaterThan(pro);
      expect(business).toBeGreaterThan(founder);
    });

    it('should have increasing pro limits with tier', () => {
      // Business rule: Higher tiers get more pro AI calls
      const pro = getUsageLimits('pro', 'pro');
      const founder = getUsageLimits('founder', 'pro');
      const business = getUsageLimits('business', 'pro');

      expect(founder).toBeGreaterThan(pro);
      expect(business).toBeGreaterThan(founder);
    });

    it('should give business tier the most AI calls', () => {
      // Business rule: Business tier has highest limits
      const businessStandard = getUsageLimits('business', 'standard');
      const businessPro = getUsageLimits('business', 'pro');

      expect(businessStandard).toBe(1000);
      expect(businessPro).toBe(500);
    });

    it('should give Pro plan 4x free tier standard calls', () => {
      // Business rule: Pro gets 4x free (as documented)
      const free = getUsageLimits('free', 'standard');
      const pro = getUsageLimits('pro', 'standard');

      expect(pro).toBe(free * 4);
    });

    it('should give Founder plan 10x free tier standard calls', () => {
      // Business rule: Founder gets 10x free (as documented)
      const free = getUsageLimits('free', 'standard');
      const founder = getUsageLimits('founder', 'standard');

      expect(founder).toBe(free * 10);
    });

    it('should give Business plan 20x free tier standard calls', () => {
      // Business rule: Business gets 20x free (as documented)
      const free = getUsageLimits('free', 'standard');
      const business = getUsageLimits('business', 'standard');

      expect(business).toBe(free * 20);
    });
  });
});
