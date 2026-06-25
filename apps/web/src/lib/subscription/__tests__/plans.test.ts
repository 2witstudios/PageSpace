import { describe, it, expect } from 'vitest';
import {
  PLANS,
  PLAN_ORDER,
  getPlan,
  getNextPlan,
  getPreviousPlan,
  canUpgrade,
  canDowngrade,
  getAllPlans,
  type SubscriptionTier,
} from '../plans';

describe('Subscription Plans', () => {
  describe('PLANS constant', () => {
    it('should define all four subscription tiers', () => {
      expect(Object.keys(PLANS)).toHaveLength(4);
      expect(PLANS.free).toBeDefined();
      expect(PLANS.pro).toBeDefined();
      expect(PLANS.founder).toBeDefined();
      expect(PLANS.business).toBeDefined();
    });

    it('should have correct prices for each tier', () => {
      expect(PLANS.free.price.monthly).toBe(0);
      expect(PLANS.pro.price.monthly).toBe(15);
      expect(PLANS.founder.price.monthly).toBe(50);
      expect(PLANS.business.price.monthly).toBe(100);
    });

    it('should grant a monthly AI-credit allowance per tier, increasing by price', () => {
      // Allowances come from the canonical billing constants (whole cents).
      expect(PLANS.free.limits.monthlyCreditsCents).toBeGreaterThan(0);
      expect(PLANS.pro.limits.monthlyCreditsCents).toBeGreaterThan(PLANS.free.limits.monthlyCreditsCents);
      expect(PLANS.founder.limits.monthlyCreditsCents).toBeGreaterThan(PLANS.pro.limits.monthlyCreditsCents);
      expect(PLANS.business.limits.monthlyCreditsCents).toBeGreaterThan(PLANS.founder.limits.monthlyCreditsCents);
    });

    it('should confine free tier to standard models and grant Pro models on paid tiers', () => {
      expect(PLANS.free.limits.proModels).toBe(false);
      expect(PLANS.pro.limits.proModels).toBe(true);
      expect(PLANS.founder.limits.proModels).toBe(true);
      expect(PLANS.business.limits.proModels).toBe(true);
    });

    it('should have correct storage limits for each tier', () => {
      expect(PLANS.free.limits.storage.bytes).toBe(500 * 1024 * 1024); // 500MB
      expect(PLANS.pro.limits.storage.bytes).toBe(2 * 1024 * 1024 * 1024); // 2GB
      expect(PLANS.founder.limits.storage.bytes).toBe(10 * 1024 * 1024 * 1024); // 10GB
      expect(PLANS.business.limits.storage.bytes).toBe(50 * 1024 * 1024 * 1024); // 50GB
    });

    it('should have correct max file size limits for each tier', () => {
      expect(PLANS.free.limits.maxFileSize.bytes).toBe(50 * 1024 * 1024); // 50MB
      expect(PLANS.pro.limits.maxFileSize.bytes).toBe(250 * 1024 * 1024); // 250MB
      expect(PLANS.founder.limits.maxFileSize.bytes).toBe(500 * 1024 * 1024); // 500MB
      expect(PLANS.business.limits.maxFileSize.bytes).toBe(1024 * 1024 * 1024); // 1GB
    });

    it('should have Stripe price IDs for paid tiers only', () => {
      expect(PLANS.free.stripePriceId).toBeUndefined();
      expect(PLANS.pro.stripePriceId).toBeDefined();
      expect(PLANS.founder.stripePriceId).toBeDefined();
      expect(PLANS.business.stripePriceId).toBeDefined();
    });

    it('should mark Pro plan as highlighted', () => {
      expect(PLANS.free.highlighted).toBeFalsy();
      expect(PLANS.pro.highlighted).toBe(true);
      expect(PLANS.founder.highlighted).toBeFalsy();
      expect(PLANS.business.highlighted).toBeFalsy();
    });
  });

  describe('PLAN_ORDER constant', () => {
    it('should define correct tier order from lowest to highest', () => {
      expect(PLAN_ORDER).toEqual(['free', 'pro', 'founder', 'business']);
    });
  });

  describe('getPlan()', () => {
    it('should return correct plan for free tier', () => {
      const plan = getPlan('free');
      expect(plan.id).toBe('free');
      expect(plan.name).toBe('Free');
    });

    it('should return correct plan for pro tier', () => {
      const plan = getPlan('pro');
      expect(plan.id).toBe('pro');
      expect(plan.name).toBe('Pro');
    });

    it('should return correct plan for founder tier', () => {
      const plan = getPlan('founder');
      expect(plan.id).toBe('founder');
      expect(plan.name).toBe('Founder');
    });

    it('should return correct plan for business tier', () => {
      const plan = getPlan('business');
      expect(plan.id).toBe('business');
      expect(plan.name).toBe('Business');
    });

    it('should return free plan for unknown tier', () => {
      const plan = getPlan('unknown' as SubscriptionTier);
      expect(plan.id).toBe('free');
    });
  });

  describe('getNextPlan()', () => {
    it('should return pro for free tier', () => {
      const next = getNextPlan('free');
      expect(next).not.toBeNull();
      expect(next?.id).toBe('pro');
    });

    it('should return founder for pro tier', () => {
      const next = getNextPlan('pro');
      expect(next).not.toBeNull();
      expect(next?.id).toBe('founder');
    });

    it('should return business for founder tier', () => {
      const next = getNextPlan('founder');
      expect(next).not.toBeNull();
      expect(next?.id).toBe('business');
    });

    it('should return null for business tier (highest)', () => {
      const next = getNextPlan('business');
      expect(next).toBeNull();
    });
  });

  describe('getPreviousPlan()', () => {
    it('should return null for free tier (lowest)', () => {
      const prev = getPreviousPlan('free');
      expect(prev).toBeNull();
    });

    it('should return free for pro tier', () => {
      const prev = getPreviousPlan('pro');
      expect(prev).not.toBeNull();
      expect(prev?.id).toBe('free');
    });

    it('should return pro for founder tier', () => {
      const prev = getPreviousPlan('founder');
      expect(prev).not.toBeNull();
      expect(prev?.id).toBe('pro');
    });

    it('should return founder for business tier', () => {
      const prev = getPreviousPlan('business');
      expect(prev).not.toBeNull();
      expect(prev?.id).toBe('founder');
    });
  });

  describe('canUpgrade()', () => {
    it('should return true for free tier', () => {
      expect(canUpgrade('free')).toBe(true);
    });

    it('should return true for pro tier', () => {
      expect(canUpgrade('pro')).toBe(true);
    });

    it('should return true for founder tier', () => {
      expect(canUpgrade('founder')).toBe(true);
    });

    it('should return false for business tier (highest)', () => {
      expect(canUpgrade('business')).toBe(false);
    });
  });

  describe('canDowngrade()', () => {
    it('should return false for free tier (lowest)', () => {
      expect(canDowngrade('free')).toBe(false);
    });

    it('should return true for pro tier', () => {
      expect(canDowngrade('pro')).toBe(true);
    });

    it('should return true for founder tier', () => {
      expect(canDowngrade('founder')).toBe(true);
    });

    it('should return true for business tier', () => {
      expect(canDowngrade('business')).toBe(true);
    });
  });

  describe('getAllPlans()', () => {
    it('should return all plans in correct order', () => {
      const plans = getAllPlans();
      expect(plans).toHaveLength(4);
      expect(plans[0].id).toBe('free');
      expect(plans[1].id).toBe('pro');
      expect(plans[2].id).toBe('founder');
      expect(plans[3].id).toBe('business');
    });

    it('should return plans with increasing prices', () => {
      const plans = getAllPlans();
      for (let i = 1; i < plans.length; i++) {
        expect(plans[i].price.monthly).toBeGreaterThan(plans[i - 1].price.monthly);
      }
    });

    it('should return plans with increasing monthly AI-credit allowances', () => {
      const plans = getAllPlans();
      for (let i = 1; i < plans.length; i++) {
        expect(plans[i].limits.monthlyCreditsCents).toBeGreaterThan(plans[i - 1].limits.monthlyCreditsCents);
      }
    });
    });

    it('should gate canChooseSubdomain to Pro and above', () => {
      expect(PLANS.free.limits.canChooseSubdomain).toBe(false);
      expect(PLANS.pro.limits.canChooseSubdomain).toBe(true);
      expect(PLANS.founder.limits.canChooseSubdomain).toBe(true);
      expect(PLANS.business.limits.canChooseSubdomain).toBe(true);
    });
  });
});
