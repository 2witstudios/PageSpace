import { describe, it, expect } from 'vitest';
import {
  ORG_PLANS,
  ORG_TIER_ORDER,
  getOrgPlan,
  canAddMember,
  getOrgStorageLimit,
  type OrgBillingTier,
} from '../billing-plans';

describe('ORG_PLANS', () => {
  it('should define all 4 tiers', () => {
    expect(Object.keys(ORG_PLANS)).toHaveLength(4);
    expect(ORG_PLANS.free).toBeDefined();
    expect(ORG_PLANS.pro).toBeDefined();
    expect(ORG_PLANS.business).toBeDefined();
    expect(ORG_PLANS.enterprise).toBeDefined();
  });

  it('should have increasing prices per tier', () => {
    // Enterprise is custom (0), skip it
    expect(ORG_PLANS.free.pricePerSeat).toBe(0);
    expect(ORG_PLANS.pro.pricePerSeat).toBeGreaterThan(0);
    expect(ORG_PLANS.business.pricePerSeat).toBeGreaterThan(ORG_PLANS.pro.pricePerSeat);
  });

  it('should have Pro between $12-15/user', () => {
    expect(ORG_PLANS.pro.pricePerSeat).toBeGreaterThanOrEqual(12);
    expect(ORG_PLANS.pro.pricePerSeat).toBeLessThanOrEqual(15);
  });

  it('should have Business between $25-30/user', () => {
    expect(ORG_PLANS.business.pricePerSeat).toBeGreaterThanOrEqual(25);
    expect(ORG_PLANS.business.pricePerSeat).toBeLessThanOrEqual(30);
  });

  it('should have increasing member limits', () => {
    expect(ORG_PLANS.free.limits.maxMembers).toBeLessThan(ORG_PLANS.pro.limits.maxMembers);
    expect(ORG_PLANS.pro.limits.maxMembers).toBeLessThan(ORG_PLANS.business.limits.maxMembers);
    expect(ORG_PLANS.enterprise.limits.maxMembers).toBe(-1); // unlimited
  });

  it('should have increasing storage per seat', () => {
    expect(ORG_PLANS.free.limits.storagePerSeatBytes).toBeLessThan(ORG_PLANS.pro.limits.storagePerSeatBytes);
    expect(ORG_PLANS.pro.limits.storagePerSeatBytes).toBeLessThan(ORG_PLANS.business.limits.storagePerSeatBytes);
    expect(ORG_PLANS.business.limits.storagePerSeatBytes).toBeLessThan(ORG_PLANS.enterprise.limits.storagePerSeatBytes);
  });
});

describe('ORG_TIER_ORDER', () => {
  it('should list tiers in ascending order', () => {
    expect(ORG_TIER_ORDER).toEqual(['free', 'pro', 'business', 'enterprise']);
  });
});

describe('getOrgPlan', () => {
  it('should return correct plan for valid tier', () => {
    const plan = getOrgPlan('pro');
    expect(plan.id).toBe('pro');
    expect(plan.name).toBe('Pro');
  });

  it('should return free plan for invalid tier', () => {
    const plan = getOrgPlan('invalid' as OrgBillingTier);
    expect(plan.id).toBe('free');
  });
});

describe('canAddMember', () => {
  it('should allow adding when under limit', () => {
    expect(canAddMember('free', 1)).toBe(true);
    expect(canAddMember('free', 2)).toBe(true);
  });

  it('should deny adding when at limit', () => {
    expect(canAddMember('free', 3)).toBe(false);
  });

  it('should always allow for unlimited tiers', () => {
    expect(canAddMember('enterprise', 9999)).toBe(true);
  });

  it('should respect Pro tier limits', () => {
    expect(canAddMember('pro', 24)).toBe(true);
    expect(canAddMember('pro', 25)).toBe(false);
  });

  it('should respect Business tier limits', () => {
    expect(canAddMember('business', 99)).toBe(true);
    expect(canAddMember('business', 100)).toBe(false);
  });
});

describe('getOrgStorageLimit', () => {
  it('should scale storage by seat count', () => {
    const freeStoragePerSeat = ORG_PLANS.free.limits.storagePerSeatBytes;
    expect(getOrgStorageLimit('free', 1)).toBe(freeStoragePerSeat);
    expect(getOrgStorageLimit('free', 3)).toBe(freeStoragePerSeat * 3);
  });

  it('should return higher limits for higher tiers', () => {
    const freeLimit = getOrgStorageLimit('free', 5);
    const proLimit = getOrgStorageLimit('pro', 5);
    expect(proLimit).toBeGreaterThan(freeLimit);
  });
});
