import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireCodeExecutionSlot,
  releaseCodeExecutionSlot,
  canAcquireCodeExecutionSlot,
  getCodeExecutionConcurrencyLimit,
  resetCodeExecutionConcurrency,
  checkCodeExecutionQuota,
  chargeCodeExecutionBudget,
  type CodeExecutionQuotaDeps,
} from '../quota';

const allowAll: CodeExecutionQuotaDeps['checkRateLimitStatus'] = async () => ({
  blocked: false,
});

function makeDeps(
  overrides: Partial<CodeExecutionQuotaDeps> = {},
): CodeExecutionQuotaDeps {
  return {
    checkRateLimitStatus: allowAll,
    canAcquireSlot: () => true,
    ...overrides,
  };
}

describe('code execution concurrency semaphore', () => {
  beforeEach(() => {
    resetCodeExecutionConcurrency();
  });

  it('should scale the concurrent-run limit by subscription tier', () => {
    expect(getCodeExecutionConcurrencyLimit('free')).toBeLessThan(
      getCodeExecutionConcurrencyLimit('business'),
    );
  });

  it('should deny acquiring a slot once the per-tier limit is reached', () => {
    expect(acquireCodeExecutionSlot({ userId: 'u1', tier: 'free' })).toBe(true);
    expect(canAcquireCodeExecutionSlot({ userId: 'u1', tier: 'free' })).toBe(false);
    expect(acquireCodeExecutionSlot({ userId: 'u1', tier: 'free' })).toBe(false);
  });

  it('should free capacity again after a slot is released', () => {
    acquireCodeExecutionSlot({ userId: 'u1', tier: 'free' });
    releaseCodeExecutionSlot({ userId: 'u1' });
    expect(canAcquireCodeExecutionSlot({ userId: 'u1', tier: 'free' })).toBe(true);
  });

  it('should track concurrency independently per user', () => {
    acquireCodeExecutionSlot({ userId: 'u1', tier: 'free' });
    expect(canAcquireCodeExecutionSlot({ userId: 'u2', tier: 'free' })).toBe(true);
  });
});

describe('checkCodeExecutionQuota', () => {
  beforeEach(() => {
    resetCodeExecutionConcurrency();
  });

  it('given capacity and budget, should allow', async () => {
    const decision = await checkCodeExecutionQuota({
      userId: 'u1',
      driveId: 'd1',
      tier: 'pro',
      deps: makeDeps(),
    });
    expect(decision.allowed).toBe(true);
  });

  it('given no concurrency capacity, should deny with concurrency_limit', async () => {
    const decision = await checkCodeExecutionQuota({
      userId: 'u1',
      driveId: 'd1',
      tier: 'pro',
      deps: makeDeps({ canAcquireSlot: () => false }),
    });
    expect(decision).toEqual({ allowed: false, reason: 'concurrency_limit' });
  });

  it('given the per-user daily budget is exhausted, should deny with rate_limited', async () => {
    const decision = await checkCodeExecutionQuota({
      userId: 'u1',
      driveId: 'd1',
      tier: 'pro',
      deps: makeDeps({
        checkRateLimitStatus: async (id: string) =>
          id.includes('user:u1')
            ? { blocked: true, retryAfter: 3600 }
            : { blocked: false },
      }),
    });
    expect(decision).toEqual({ allowed: false, reason: 'rate_limited', retryAfter: 3600 });
  });

  it('given the drive-scoped budget is exhausted, should deny with rate_limited', async () => {
    const decision = await checkCodeExecutionQuota({
      userId: 'u1',
      driveId: 'd1',
      tier: 'pro',
      deps: makeDeps({
        checkRateLimitStatus: async (id: string) =>
          id.includes('drive:d1')
            ? { blocked: true, retryAfter: 60 }
            : { blocked: false },
      }),
    });
    expect(decision).toEqual({ allowed: false, reason: 'rate_limited', retryAfter: 60 });
  });

  it('given a tenant-scoped budget exhaustion, should deny with rate_limited', async () => {
    const decision = await checkCodeExecutionQuota({
      userId: 'u1',
      driveId: 'd1',
      tenantId: 't1',
      tier: 'pro',
      deps: makeDeps({
        checkRateLimitStatus: async (id: string) =>
          id.includes('tenant:t1')
            ? { blocked: true, retryAfter: 120 }
            : { blocked: false },
      }),
    });
    expect(decision).toEqual({ allowed: false, reason: 'rate_limited', retryAfter: 120 });
  });

  it('should check concurrency before reading budget so a full system never queries quota', async () => {
    let statusCalls = 0;
    await checkCodeExecutionQuota({
      userId: 'u1',
      driveId: 'd1',
      tier: 'pro',
      deps: makeDeps({
        canAcquireSlot: () => false,
        checkRateLimitStatus: async () => {
          statusCalls += 1;
          return { blocked: false };
        },
      }),
    });
    expect(statusCalls).toBe(0);
  });
});

describe('chargeCodeExecutionBudget', () => {
  it('given user, drive, and tenant, should charge all three scopes exactly once', async () => {
    const charged: string[] = [];
    await chargeCodeExecutionBudget({
      userId: 'u1',
      driveId: 'd1',
      tenantId: 't1',
      deps: { charge: async (id) => { charged.push(id); } },
    });
    expect(charged.sort()).toEqual(
      ['code-exec:drive:d1', 'code-exec:tenant:t1', 'code-exec:user:u1'].sort(),
    );
  });

  it('given no tenant, should charge only the user and drive scopes', async () => {
    const charged: string[] = [];
    await chargeCodeExecutionBudget({
      userId: 'u1',
      driveId: 'd1',
      deps: { charge: async (id) => { charged.push(id); } },
    });
    expect(charged.sort()).toEqual(['code-exec:drive:d1', 'code-exec:user:u1']);
  });
});
