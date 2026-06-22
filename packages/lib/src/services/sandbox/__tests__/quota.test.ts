import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireCodeExecutionSlot,
  releaseCodeExecutionSlot,
  canAcquireCodeExecutionSlot,
  getCodeExecutionConcurrencyLimit,
  resetCodeExecutionConcurrency,
  checkCodeExecutionQuota,
  type CodeExecutionQuotaDeps,
} from '../quota';

function makeDeps(
  overrides: Partial<CodeExecutionQuotaDeps> = {},
): CodeExecutionQuotaDeps {
  return {
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

  it('given concurrency capacity, should allow', async () => {
    const decision = await checkCodeExecutionQuota({
      userId: 'u1',
      driveId: 'd1',
      tier: 'pro',
      deps: makeDeps(),
    });
    expect(decision).toEqual({ allowed: true });
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

  it('given no driveId (global context) and concurrency capacity, should allow', async () => {
    const decision = await checkCodeExecutionQuota({
      userId: 'u1',
      tier: 'pro',
      deps: makeDeps(),
    });
    expect(decision).toEqual({ allowed: true });
  });
});
