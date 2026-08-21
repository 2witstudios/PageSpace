import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  acquireCodeExecutionSlot,
  canAcquireCodeExecutionSlot,
  checkAgentSessionConcurrency,
  checkCodeExecutionQuota,
  checkDriveEnvAllowance,
  getCodeExecutionConcurrencyLimit,
  getDriveEnvLimit,
  releaseCodeExecutionSlot,
  resetCodeExecutionConcurrency,
} from '../quota';

/**
 * Tenant deployments bypass tier ELIGIBILITY, not the ceilings.
 *
 * The stored `subscriptionTier` on a tenant is `free` (the control-plane seeder
 * deliberately leaves the column at its default — nothing there sells or
 * reconciles it), so every case below passes 'free' on purpose: that is the
 * value the real deployment actually holds, and the bug being fixed is that it
 * denied the entire sandbox surface to a customer who bought the deployment.
 */
const TENANT_STORED_TIER = 'free' as const;

beforeEach(() => {
  resetCodeExecutionConcurrency();
  vi.stubEnv('DEPLOYMENT_MODE', 'tenant');
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetCodeExecutionConcurrency();
});

describe('tenant: eligibility is bypassed', () => {
  it('code-execution quota admits the seeded free tier', async () => {
    expect(await checkCodeExecutionQuota({ userId: 'u1', tier: TENANT_STORED_TIER })).toEqual({ allowed: true });
  });

  it('agent-session concurrency admits the seeded free tier', async () => {
    const decision = await checkAgentSessionConcurrency({
      ownerId: 'u1',
      tier: TENANT_STORED_TIER,
      countLiveAgentSessions: async () => 0,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('env allowance admits the seeded free tier — free is 0 envs on cloud, and would deny outright', async () => {
    const decision = await checkDriveEnvAllowance({
      payerId: 'u1',
      tier: TENANT_STORED_TIER,
      countEnvsOwnedBy: async () => 0,
    });
    expect(decision).toEqual({ allowed: true });
  });
});

describe('tenant: the runaway guards still bite', () => {
  it('ceilings resolve to the tenant effective tier, not free', () => {
    expect(getCodeExecutionConcurrencyLimit(TENANT_STORED_TIER)).toBe(50);
    expect(getDriveEnvLimit(TENANT_STORED_TIER)).toBe(10);
  });

  it('the env ceiling is a real cap, not an exemption', async () => {
    const limit = getDriveEnvLimit(TENANT_STORED_TIER);
    expect(limit).toBeGreaterThan(0);
    const decision = await checkDriveEnvAllowance({
      payerId: 'u1',
      tier: TENANT_STORED_TIER,
      countEnvsOwnedBy: async () => limit,
    });
    expect(decision).toEqual({ allowed: false, reason: 'env_limit_reached', limit });
  });

  it('the live-session ceiling is a real cap', async () => {
    const limit = getCodeExecutionConcurrencyLimit(TENANT_STORED_TIER);
    const decision = await checkAgentSessionConcurrency({
      ownerId: 'u1',
      tier: TENANT_STORED_TIER,
      countLiveAgentSessions: async () => limit,
    });
    expect(decision).toEqual({ allowed: false, reason: 'concurrency_limit' });
  });

  it('the real semaphore refuses once the tenant ceiling is full', () => {
    const limit = getCodeExecutionConcurrencyLimit(TENANT_STORED_TIER);
    for (let i = 0; i < limit; i++) {
      expect(acquireCodeExecutionSlot({ userId: 'u1', tier: TENANT_STORED_TIER })).toBe(true);
    }
    expect(canAcquireCodeExecutionSlot({ userId: 'u1', tier: TENANT_STORED_TIER })).toBe(false);
    releaseCodeExecutionSlot({ userId: 'u1' });
    expect(canAcquireCodeExecutionSlot({ userId: 'u1', tier: TENANT_STORED_TIER })).toBe(true);
  });
});

describe('cloud and onprem are unaffected by the tenant bypass', () => {
  it('cloud still denies the free tier and still uses free ceilings', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
    expect(getCodeExecutionConcurrencyLimit('free')).toBe(1);
    expect(getDriveEnvLimit('free')).toBe(0);
    expect(await checkCodeExecutionQuota({ userId: 'u1', tier: 'free' })).toEqual({
      allowed: false,
      reason: 'tier_ineligible',
    });
  });

  it('onprem still denies the free tier — the bypass is tenant-only', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'onprem');
    expect(getDriveEnvLimit('free')).toBe(0);
    expect(
      await checkDriveEnvAllowance({ payerId: 'u1', tier: 'free', countEnvsOwnedBy: async () => 0 }),
    ).toEqual({ allowed: false, reason: 'tier_ineligible', limit: 0 });
  });
});
