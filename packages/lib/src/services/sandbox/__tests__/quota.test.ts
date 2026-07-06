import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  acquireCodeExecutionSlot,
  releaseCodeExecutionSlot,
  canAcquireCodeExecutionSlot,
  getCodeExecutionConcurrencyLimit,
  resetCodeExecutionConcurrency,
  checkCodeExecutionQuota,
  checkMachineRuntimeGuardrail,
  recordMachineActivity,
  resetMachineRuntimeGuardrail,
  getMachineMaxActiveSeconds,
  machineActivityMapSize,
  MACHINE_ACTIVITY_GRACE_MS,
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

describe('machine runtime guardrail', () => {
  const ORIGINAL_ENV = process.env.TERMINAL_MACHINE_MAX_ACTIVE_SECONDS;

  beforeEach(() => {
    resetMachineRuntimeGuardrail();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.TERMINAL_MACHINE_MAX_ACTIVE_SECONDS;
    } else {
      process.env.TERMINAL_MACHINE_MAX_ACTIVE_SECONDS = ORIGINAL_ENV;
    }
  });

  it('given a fresh machine with no recorded activity, should allow', () => {
    const decision = checkMachineRuntimeGuardrail({ machineKey: 'm1', now: 1_000, maxActiveSeconds: 60 });
    expect(decision).toEqual({ allowed: true });
  });

  it('given continuous activity under the cap, should allow', () => {
    recordMachineActivity({ machineKey: 'm1', now: 0 });
    recordMachineActivity({ machineKey: 'm1', now: 30_000 });
    const decision = checkMachineRuntimeGuardrail({ machineKey: 'm1', now: 59_000, maxActiveSeconds: 60 });
    expect(decision).toEqual({ allowed: true });
  });

  it('given continuous activity that crosses the cap, should deny machine_runtime_exceeded', () => {
    recordMachineActivity({ machineKey: 'm1', now: 0 });
    recordMachineActivity({ machineKey: 'm1', now: 30_000 });
    const decision = checkMachineRuntimeGuardrail({ machineKey: 'm1', now: 61_000, maxActiveSeconds: 60 });
    expect(decision).toEqual({ allowed: false, reason: 'machine_runtime_exceeded' });
  });

  it('given a gap longer than the grace window, should reset the continuous-activity clock', () => {
    recordMachineActivity({ machineKey: 'm1', now: 0 });
    // Exceed the cap, but only after a long idle gap — the clock should have reset.
    const idleGapEnd = MACHINE_ACTIVITY_GRACE_MS + 1;
    recordMachineActivity({ machineKey: 'm1', now: idleGapEnd });
    const decision = checkMachineRuntimeGuardrail({
      machineKey: 'm1',
      now: idleGapEnd + 60_000,
      maxActiveSeconds: 60,
    });
    // 60s since the reset at idleGapEnd — right at the cap, not yet over it.
    expect(decision).toEqual({ allowed: false, reason: 'machine_runtime_exceeded' });

    // A fresh key never touched near the deadline stays under budget.
    const freshDecision = checkMachineRuntimeGuardrail({
      machineKey: 'm1',
      now: idleGapEnd + 1,
      maxActiveSeconds: 60,
    });
    expect(freshDecision).toEqual({ allowed: true });
  });

  it('given activity on one machine, should track another machine independently', () => {
    recordMachineActivity({ machineKey: 'm1', now: 0 });
    const decision = checkMachineRuntimeGuardrail({ machineKey: 'm2', now: 61_000, maxActiveSeconds: 60 });
    expect(decision).toEqual({ allowed: true });
  });

  it('given no env override, should default to 4 hours', () => {
    delete process.env.TERMINAL_MACHINE_MAX_ACTIVE_SECONDS;
    expect(getMachineMaxActiveSeconds()).toBe(4 * 60 * 60);
  });

  it('given a valid env override, should use it', () => {
    process.env.TERMINAL_MACHINE_MAX_ACTIVE_SECONDS = '120';
    expect(getMachineMaxActiveSeconds()).toBe(120);
  });

  it('given an invalid env override, should fall back to the default', () => {
    process.env.TERMINAL_MACHINE_MAX_ACTIVE_SECONDS = 'not-a-number';
    expect(getMachineMaxActiveSeconds()).toBe(4 * 60 * 60);
  });

  it('given a machine that has gone idle past the grace window, should evict its entry (bounded memory)', () => {
    recordMachineActivity({ machineKey: 'stale-machine', now: 0 });
    expect(machineActivityMapSize()).toBe(1);

    // A later acquisition on a DIFFERENT machine, well past the first
    // machine's grace window, should sweep the stale entry rather than
    // accumulating it forever.
    const now = MACHINE_ACTIVITY_GRACE_MS + 1;
    recordMachineActivity({ machineKey: 'other-machine', now });

    expect(machineActivityMapSize()).toBe(1);
  });

  it('given many machines that all go idle, should not grow unbounded across acquisitions', () => {
    for (let i = 0; i < 50; i++) {
      recordMachineActivity({ machineKey: `machine-${i}`, now: 0 });
    }
    expect(machineActivityMapSize()).toBe(50);

    // One more acquisition, long after all 50 went idle, should sweep them all.
    recordMachineActivity({ machineKey: 'fresh-machine', now: MACHINE_ACTIVITY_GRACE_MS + 1 });

    expect(machineActivityMapSize()).toBe(1);
  });
});
