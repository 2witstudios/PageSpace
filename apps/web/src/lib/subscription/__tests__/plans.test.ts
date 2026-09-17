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
  getPersonalPlans,
  withCreditsCents,
  withCreditOverrides,
  isPersonalPlanPriceId,
  type SubscriptionTier,
} from '../plans';
import { stripeConfig } from '../../stripe-config';

describe('Subscription Plans', () => {
  describe('PLANS constant', () => {
    it('SEAT-2 (partial) defines exactly the three subscription tiers: Free, Pro, Business', () => {
      expect(Object.keys(PLANS)).toEqual(['free', 'pro', 'business']);
    });

    it('A-9 has no founder plan', () => {
      expect('founder' in PLANS).toBe(false);
    });

    it('SEAT-2 (partial) prices are $0 / $15 / $50 a month', () => {
      expect(PLANS.free.price.monthly).toBe(0);
      expect(PLANS.pro.price.monthly).toBe(15);
      expect(PLANS.business.price.monthly).toBe(50);
    });

    it('SEAT-2 (partial) Business is the org plan with 5 seats included at $10 per extra seat; Free and Pro are personal', () => {
      expect(PLANS.business).toMatchObject({ isOrgPlan: true, includedSeats: 5, extraSeatUsd: 10 });
      expect(PLANS.pro).toMatchObject({ isOrgPlan: false, includedSeats: 0, extraSeatUsd: 0 });
      expect(PLANS.free).toMatchObject({ isOrgPlan: false, includedSeats: 0, extraSeatUsd: 0 });
    });

    it('MON-6 every plan states included credits as an integer count and the top-up rate as separate facts', () => {
      for (const plan of getAllPlans()) {
        expect(plan.includedCredits).toMatch(/^[0-9,]+ credits (included each month|to start)$/);
        expect(plan.includedCredits).not.toContain('$');
        expect(plan.topUpRate).toMatch(/^[0-9,]+ credits per \$[0-9]+$/);
        expect(plan.price.formatted).not.toContain('credit');
      }
      expect(PLANS.free.includedCredits).toMatch(/to start$/);
      expect(PLANS.pro.includedCredits).toMatch(/included each month$/);
    });

    it('should grant a monthly AI-credit allowance per tier, increasing by rank', () => {
      // Allowances come from the canonical billing constants (whole cents).
      expect(PLANS.free.limits.monthlyCreditsCents).toBeGreaterThan(0);
      expect(PLANS.pro.limits.monthlyCreditsCents).toBeGreaterThan(PLANS.free.limits.monthlyCreditsCents);
      expect(PLANS.business.limits.monthlyCreditsCents).toBeGreaterThan(PLANS.pro.limits.monthlyCreditsCents);
    });

    it('should confine free tier to standard models and grant Pro models on paid tiers', () => {
      expect(PLANS.free.limits.proModels).toBe(false);
      expect(PLANS.pro.limits.proModels).toBe(true);
      expect(PLANS.business.limits.proModels).toBe(true);
    });

    it('should have correct storage limits for each tier', () => {
      expect(PLANS.free.limits.storage.bytes).toBe(500 * 1024 * 1024); // 500MB
      expect(PLANS.pro.limits.storage.bytes).toBe(2 * 1024 * 1024 * 1024); // 2GB
      expect(PLANS.business.limits.storage.bytes).toBe(50 * 1024 * 1024 * 1024); // 50GB
    });

    it('should have correct max file size limits for each tier', () => {
      expect(PLANS.free.limits.maxFileSize.bytes).toBe(50 * 1024 * 1024); // 50MB
      expect(PLANS.pro.limits.maxFileSize.bytes).toBe(250 * 1024 * 1024); // 250MB
      expect(PLANS.business.limits.maxFileSize.bytes).toBe(1024 * 1024 * 1024); // 1GB
    });

    it('should have Stripe price IDs for paid tiers only', () => {
      expect(PLANS.free.stripePriceId).toBeUndefined();
      expect(PLANS.pro.stripePriceId).toBeDefined();
      expect(PLANS.business.stripePriceId).toBeDefined();
    });

    it('should mark Pro plan as highlighted', () => {
      expect(PLANS.free.highlighted).toBeFalsy();
      expect(PLANS.pro.highlighted).toBe(true);
      expect(PLANS.business.highlighted).toBeFalsy();
    });
  });

  describe('PLAN_ORDER constant', () => {
    it('SEAT-2 (partial) defines tier order from lowest to highest', () => {
      expect(PLAN_ORDER).toEqual(['free', 'pro', 'business']);
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

    it('should return correct plan for business tier', () => {
      const plan = getPlan('business');
      expect(plan.id).toBe('business');
      expect(plan.name).toBe('Business');
    });

    it('should return free plan for unknown tier (including the retired founder value)', () => {
      expect(getPlan('unknown' as SubscriptionTier).id).toBe('free');
      expect(getPlan('founder' as SubscriptionTier).id).toBe('free');
    });
  });

  describe('getNextPlan()', () => {
    it('should return pro for free tier', () => {
      expect(getNextPlan('free')?.id).toBe('pro');
    });

    it('should return business for pro tier', () => {
      expect(getNextPlan('pro')?.id).toBe('business');
    });

    it('should return null for business tier (highest)', () => {
      expect(getNextPlan('business')).toBeNull();
    });
  });

  describe('getPreviousPlan()', () => {
    it('should return null for free tier (lowest)', () => {
      expect(getPreviousPlan('free')).toBeNull();
    });

    it('should return free for pro tier', () => {
      expect(getPreviousPlan('pro')?.id).toBe('free');
    });

    it('should return pro for business tier', () => {
      expect(getPreviousPlan('business')?.id).toBe('pro');
    });
  });

  describe('canUpgrade()', () => {
    it('should return true for free and pro', () => {
      expect(canUpgrade('free')).toBe(true);
      expect(canUpgrade('pro')).toBe(true);
    });

    it('should return false for business tier (highest)', () => {
      expect(canUpgrade('business')).toBe(false);
    });
  });

  describe('canDowngrade()', () => {
    it('should return false for free tier (lowest)', () => {
      expect(canDowngrade('free')).toBe(false);
    });

    it('should return true for pro and business', () => {
      expect(canDowngrade('pro')).toBe(true);
      expect(canDowngrade('business')).toBe(true);
    });
  });

  describe('getAllPlans()', () => {
    it('should return all plans in correct order', () => {
      const plans = getAllPlans();
      expect(plans.map((p) => p.id)).toEqual(['free', 'pro', 'business']);
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

    it('should gate canChooseSubdomain to Pro and above', () => {
      expect(PLANS.free.limits.canChooseSubdomain).toBe(false);
      expect(PLANS.pro.limits.canChooseSubdomain).toBe(true);
      expect(PLANS.business.limits.canChooseSubdomain).toBe(true);
    });
  });

  describe('getPersonalPlans()', () => {
    it('SEAT-2 (partial) never offers the org plan (Business) to a lone user', () => {
      expect(getPersonalPlans().map((p) => p.id)).toEqual(['free', 'pro']);
      expect(getPersonalPlans('free').map((p) => p.id)).toEqual(['free', 'pro']);
      expect(getPersonalPlans('pro').map((p) => p.id)).toEqual(['free', 'pro']);
    });

    it('A-9 a grandfathered Business subscriber still sees their own plan', () => {
      expect(getPersonalPlans('business').map((p) => p.id)).toEqual(['free', 'pro', 'business']);
    });
  });

  describe('isPersonalPlanPriceId()', () => {
    it('SEAT-2 (partial) P1 (independent review) is true for the Pro price id — the one price a lone user may buy today', () => {
      expect(isPersonalPlanPriceId(PLANS.pro.stripePriceId!)).toBe(true);
    });

    it('is false for the Business (org-plan) price id', () => {
      expect(isPersonalPlanPriceId(PLANS.business.stripePriceId!)).toBe(false);
    });

    it('is false for the grandfathered Founder price id — a removed tier is never re-purchasable', () => {
      expect(isPersonalPlanPriceId(stripeConfig.grandfatheredPriceIds.founder)).toBe(false);
    });

    it('is false for an unrecognized price id — allowlist denies by default, it does not fall through', () => {
      expect(isPersonalPlanPriceId('price_not_a_real_plan')).toBe(false);
    });
  });
});

describe('MON-2 the settings/plan client component patches its credit copy from server data, never from a client-side env read', () => {
  describe('withCreditsCents', () => {
    it('reproduces the reported defect and its fix: the module\'s own (potentially stale) number is replaced by a server-supplied one', () => {
      // Simulates a server-supplied planCredits figure (e.g. a promo invoice)
      // that legitimately differs from the plan module's own built-in number —
      // withCreditsCents must prefer the server value, not the module's own.
      const patched = withCreditsCents(PLANS.pro, 900);
      expect(patched.limits.monthlyCreditsCents).toBe(900);
      expect(patched.includedCredits).toBe('900 credits included each month');
      expect(patched.features[0].name).toBe('900 credits/month');
    });

    it('touches only the credit-derived fields — id, price, and every other feature are untouched', () => {
      const patched = withCreditsCents(PLANS.pro, 900);
      expect(patched.id).toBe(PLANS.pro.id);
      expect(patched.price).toEqual(PLANS.pro.price);
      expect(patched.features.slice(1)).toEqual(PLANS.pro.features.slice(1));
    });

    it('renders the one-time starter phrasing for a non-refilling tier (free)', () => {
      const patched = withCreditsCents(PLANS.free, 500);
      expect(patched.includedCredits).toBe('500 credits to start');
      expect(patched.features[0].name).toBe('500 credits to start');
    });
  });

  describe('withCreditOverrides', () => {
    it('patches only the tiers present in the map; a tier with no entry keeps its own number unchanged', () => {
      const [free, pro] = withCreditOverrides([PLANS.free, PLANS.pro], { pro: 900 });
      expect(pro.limits.monthlyCreditsCents).toBe(900);
      expect(free).toBe(PLANS.free); // untouched — same reference, not just equal
    });

    it('is a no-op (returns the same array) when no server data has arrived yet', () => {
      const plans = [PLANS.free, PLANS.pro];
      expect(withCreditOverrides(plans, undefined)).toBe(plans);
      expect(withCreditOverrides(plans, {})).not.toBe(plans); // {} still maps, just patches nothing
      expect(withCreditOverrides(plans, {}).every((p, i) => p === plans[i])).toBe(true);
    });
  });
});

