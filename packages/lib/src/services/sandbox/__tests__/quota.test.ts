import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  acquireCodeExecutionSlot,
  releaseCodeExecutionSlot,
  canAcquireCodeExecutionSlot,
  getCodeExecutionConcurrencyLimit,
  resetCodeExecutionConcurrency,
  checkCodeExecutionQuota,
  checkAgentSessionConcurrency,
  checkDriveEnvAllowance,
  getDriveEnvLimit,
  checkSessionRuntimeGuardrail,
  recordSessionActivity,
  resetSessionRuntimeGuardrail,
  getSessionMaxActiveSeconds,
  sessionActivityMapSize,
  SESSION_ACTIVITY_GRACE_MS,
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
      getCodeExecutionConcurrencyLimit('pro'),
    );
    expect(getCodeExecutionConcurrencyLimit('pro')).toBeLessThan(
      getCodeExecutionConcurrencyLimit('founder'),
    );
    expect(getCodeExecutionConcurrencyLimit('founder')).toBeLessThan(
      getCodeExecutionConcurrencyLimit('business'),
    );
  });

  it('should default each tier to its documented ceiling', () => {
    expect(getCodeExecutionConcurrencyLimit('free')).toBe(1);
    expect(getCodeExecutionConcurrencyLimit('pro')).toBe(10);
    expect(getCodeExecutionConcurrencyLimit('founder')).toBe(20);
    expect(getCodeExecutionConcurrencyLimit('business')).toBe(50);
  });

  it('should deny acquiring a slot once the per-tier limit is reached', () => {
    // 'pro' (not 'free'): the concurrency ceiling itself, isolated from the
    // tier-eligibility short-circuit covered separately below — 'free' would
    // fail this immediately for the wrong reason (tier_ineligible, not the
    // ceiling this test exercises).
    for (let i = 0; i < getCodeExecutionConcurrencyLimit('pro'); i++) {
      expect(acquireCodeExecutionSlot({ userId: 'u1', tier: 'pro' })).toBe(true);
    }
    expect(canAcquireCodeExecutionSlot({ userId: 'u1', tier: 'pro' })).toBe(false);
    expect(acquireCodeExecutionSlot({ userId: 'u1', tier: 'pro' })).toBe(false);
  });

  it('should free capacity again after a slot is released', () => {
    acquireCodeExecutionSlot({ userId: 'u1', tier: 'pro' });
    releaseCodeExecutionSlot({ userId: 'u1' });
    expect(canAcquireCodeExecutionSlot({ userId: 'u1', tier: 'pro' })).toBe(true);
  });

  it('should track concurrency independently per user', () => {
    acquireCodeExecutionSlot({ userId: 'u1', tier: 'pro' });
    expect(canAcquireCodeExecutionSlot({ userId: 'u2', tier: 'pro' })).toBe(true);
  });
});

/**
 * Defense in depth: free-tier is blocked here even with concurrency
 * capacity to spare — this is the backstop, ahead of (not instead of)
 * can-run-code.ts's own tier-eligibility gate.
 */
describe('sandbox tier eligibility — defense in depth', () => {
  beforeEach(() => {
    resetCodeExecutionConcurrency();
  });

  it('canAcquireCodeExecutionSlot should deny a free-tier user even with capacity to spare', () => {
    expect(canAcquireCodeExecutionSlot({ userId: 'u1', tier: 'free' })).toBe(false);
  });

  it('acquireCodeExecutionSlot should deny a free-tier user and reserve nothing', () => {
    expect(acquireCodeExecutionSlot({ userId: 'u1', tier: 'free' })).toBe(false);
    // Nothing was reserved — a pro-tier user's capacity is untouched.
    for (let i = 0; i < getCodeExecutionConcurrencyLimit('pro'); i++) {
      expect(acquireCodeExecutionSlot({ userId: 'u2', tier: 'pro' })).toBe(true);
    }
  });
});

// CONCURRENCY_LIMITS is computed at module-import time from env vars, so each
// test re-imports the module with different env conditions (same pattern as
// MACHINE_MARKUP_BPS in credit-pricing.test.ts).
describe('CONCURRENCY_LIMITS env overrides', () => {
  const ENV_KEYS = [
    'CODE_EXEC_CONCURRENCY_FREE',
    'CODE_EXEC_CONCURRENCY_PRO',
    'CODE_EXEC_CONCURRENCY_FOUNDER',
    'CODE_EXEC_CONCURRENCY_BUSINESS',
  ] as const;
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('uses an env override when set', async () => {
    process.env.CODE_EXEC_CONCURRENCY_BUSINESS = '75';
    const { getCodeExecutionConcurrencyLimit: getLimit } = await import('../quota');
    expect(getLimit('business')).toBe(75);
  });

  it('falls back to the default when the env value is invalid', async () => {
    process.env.CODE_EXEC_CONCURRENCY_FOUNDER = 'not-a-number';
    const { getCodeExecutionConcurrencyLimit: getLimit } = await import('../quota');
    expect(getLimit('founder')).toBe(20);
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

  it('given a free-tier payer, should deny with tier_ineligible even with concurrency capacity to spare', async () => {
    const canAcquireSlot = vi.fn(() => true);
    const decision = await checkCodeExecutionQuota({
      userId: 'u1',
      driveId: 'd1',
      tier: 'free',
      deps: makeDeps({ canAcquireSlot }),
    });
    expect(decision).toEqual({ allowed: false, reason: 'tier_ineligible' });
    // Checked and short-circuited BEFORE the concurrency slot check.
    expect(canAcquireSlot).not.toHaveBeenCalled();
  });
});

describe('checkAgentSessionConcurrency', () => {
  it('given a live count under the tier ceiling, should allow', async () => {
    const decision = await checkAgentSessionConcurrency({
      ownerId: 'owner-1',
      tier: 'pro',
      countLiveAgentSessions: async () => getCodeExecutionConcurrencyLimit('pro') - 1,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('given a live count AT the tier ceiling, should deny with concurrency_limit', async () => {
    const decision = await checkAgentSessionConcurrency({
      ownerId: 'owner-1',
      tier: 'pro',
      countLiveAgentSessions: async () => getCodeExecutionConcurrencyLimit('pro'),
    });
    expect(decision).toEqual({ allowed: false, reason: 'concurrency_limit' });
  });

  it('given a live count over the tier ceiling, should deny', async () => {
    // 'pro' (not 'free'): the concurrency ceiling itself, isolated from the
    // tier-eligibility short-circuit covered separately below.
    const decision = await checkAgentSessionConcurrency({
      ownerId: 'owner-1',
      tier: 'pro',
      countLiveAgentSessions: async () => getCodeExecutionConcurrencyLimit('pro') + 5,
    });
    expect(decision).toEqual({ allowed: false, reason: 'concurrency_limit' });
  });

  it('given a free-tier owner, should deny with tier_ineligible without even counting live sessions', async () => {
    const countLiveAgentSessions = vi.fn(async () => 0);
    const decision = await checkAgentSessionConcurrency({
      ownerId: 'owner-1',
      tier: 'free',
      countLiveAgentSessions,
    });
    expect(decision).toEqual({ allowed: false, reason: 'tier_ineligible' });
    expect(countLiveAgentSessions).not.toHaveBeenCalled();
  });

  it('counts per OWNER — the count function is called with the given ownerId', async () => {
    const seen: string[] = [];
    await checkAgentSessionConcurrency({
      ownerId: 'owner-42',
      tier: 'business',
      countLiveAgentSessions: async (ownerId) => {
        seen.push(ownerId);
        return 0;
      },
    });
    expect(seen).toEqual(['owner-42']);
  });

  it('scales the ceiling by tier, reusing the same CONCURRENCY_LIMITS the run semaphore uses', async () => {
    const proLimit = getCodeExecutionConcurrencyLimit('pro');
    const decision = await checkAgentSessionConcurrency({
      ownerId: 'owner-1',
      tier: 'pro',
      countLiveAgentSessions: async () => proLimit - 1,
    });
    expect(decision).toEqual({ allowed: true });

    const atCeiling = await checkAgentSessionConcurrency({
      ownerId: 'owner-1',
      tier: 'pro',
      countLiveAgentSessions: async () => proLimit,
    });
    expect(atCeiling).toEqual({ allowed: false, reason: 'concurrency_limit' });
  });
});

describe('session runtime guardrail', () => {
  const ORIGINAL_ENV = process.env.TERMINAL_SESSION_MAX_ACTIVE_SECONDS;

  beforeEach(() => {
    resetSessionRuntimeGuardrail();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.TERMINAL_SESSION_MAX_ACTIVE_SECONDS;
    } else {
      process.env.TERMINAL_SESSION_MAX_ACTIVE_SECONDS = ORIGINAL_ENV;
    }
  });

  it('given a fresh session with no recorded activity, should allow', () => {
    const decision = checkSessionRuntimeGuardrail({ workspaceId: 'ses-1', now: 1_000, maxActiveSeconds: 60 });
    expect(decision).toEqual({ allowed: true });
  });

  it('given continuous activity under the cap, should allow', () => {
    recordSessionActivity({ workspaceId: 'ses-1', now: 0 });
    recordSessionActivity({ workspaceId: 'ses-1', now: 30_000 });
    const decision = checkSessionRuntimeGuardrail({ workspaceId: 'ses-1', now: 59_000, maxActiveSeconds: 60 });
    expect(decision).toEqual({ allowed: true });
  });

  it('given continuous activity that crosses the cap, should deny session_runtime_exceeded', () => {
    recordSessionActivity({ workspaceId: 'ses-1', now: 0 });
    recordSessionActivity({ workspaceId: 'ses-1', now: 30_000 });
    const decision = checkSessionRuntimeGuardrail({ workspaceId: 'ses-1', now: 61_000, maxActiveSeconds: 60 });
    expect(decision).toEqual({ allowed: false, reason: 'session_runtime_exceeded' });
  });

  it('given a gap longer than the grace window, should reset the continuous-activity clock', () => {
    recordSessionActivity({ workspaceId: 'ses-1', now: 0 });
    // Exceed the cap, but only after a long idle gap — the clock should have reset.
    const idleGapEnd = SESSION_ACTIVITY_GRACE_MS + 1;
    recordSessionActivity({ workspaceId: 'ses-1', now: idleGapEnd });
    const decision = checkSessionRuntimeGuardrail({
      workspaceId: 'ses-1',
      now: idleGapEnd + 60_000,
      maxActiveSeconds: 60,
    });
    // 60s since the reset at idleGapEnd — right at the cap, not yet over it.
    expect(decision).toEqual({ allowed: false, reason: 'session_runtime_exceeded' });

    // A fresh key never touched near the deadline stays under budget.
    const freshDecision = checkSessionRuntimeGuardrail({
      workspaceId: 'ses-1',
      now: idleGapEnd + 1,
      maxActiveSeconds: 60,
    });
    expect(freshDecision).toEqual({ allowed: true });
  });

  it('given activity on one session, should track another session independently', () => {
    recordSessionActivity({ workspaceId: 'ses-1', now: 0 });
    const decision = checkSessionRuntimeGuardrail({ workspaceId: 'ses-2', now: 61_000, maxActiveSeconds: 60 });
    expect(decision).toEqual({ allowed: true });
  });

  it('given no env override, should default to 4 hours', () => {
    delete process.env.TERMINAL_SESSION_MAX_ACTIVE_SECONDS;
    expect(getSessionMaxActiveSeconds()).toBe(4 * 60 * 60);
  });

  it('given a valid env override, should use it', () => {
    process.env.TERMINAL_SESSION_MAX_ACTIVE_SECONDS = '120';
    expect(getSessionMaxActiveSeconds()).toBe(120);
  });

  it('given an invalid env override, should fall back to the default', () => {
    process.env.TERMINAL_SESSION_MAX_ACTIVE_SECONDS = 'not-a-number';
    expect(getSessionMaxActiveSeconds()).toBe(4 * 60 * 60);
  });

  it('given a session that has gone idle past the grace window, should evict its entry (bounded memory)', () => {
    recordSessionActivity({ workspaceId: 'stale-session', now: 0 });
    expect(sessionActivityMapSize()).toBe(1);

    // A later acquisition on a DIFFERENT session, well past the first
    // session's grace window, should sweep the stale entry rather than
    // accumulating it forever.
    const now = SESSION_ACTIVITY_GRACE_MS + 1;
    recordSessionActivity({ workspaceId: 'other-session', now });

    expect(sessionActivityMapSize()).toBe(1);
  });

  it('given many sessions that all go idle, should not grow unbounded across acquisitions', () => {
    for (let i = 0; i < 50; i++) {
      recordSessionActivity({ workspaceId: `session-${i}`, now: 0 });
    }
    expect(sessionActivityMapSize()).toBe(50);

    // One more acquisition, long after all 50 went idle, should sweep them all.
    recordSessionActivity({ workspaceId: 'fresh-session', now: SESSION_ACTIVITY_GRACE_MS + 1 });

    expect(sessionActivityMapSize()).toBe(1);
  });
});

/**
 * The RESUME exemption. A session already holding a live sandbox is already
 * counted by `countLive`, so gating it would refuse an owner sitting at their
 * ceiling access to a Sprite they are already paying for — while a COLD session
 * must still be gated, or the ceiling means nothing.
 */
describe('checkAgentSessionConcurrency — resume exemption', () => {
  it('given a session already holding a sandbox at the ceiling, should allow without counting', async () => {
    // 'pro' (not 'free'): isolates the resume exemption from tier
    // eligibility, which overrides it regardless — see the next describe
    // block.
    const countLiveAgentSessions = vi.fn(async () => 99);

    const decision = await checkAgentSessionConcurrency({
      ownerId: 'user-1',
      tier: 'pro',
      countLiveAgentSessions,
      alreadyProvisioned: true,
    });

    expect(decision).toEqual({ allowed: true });
    // Not merely allowed — the count is not even taken, so a resume costs no query.
    expect(countLiveAgentSessions).not.toHaveBeenCalled();
  });

  it('given a COLD session at the ceiling, should still refuse', async () => {
    const decision = await checkAgentSessionConcurrency({
      ownerId: 'user-1',
      tier: 'pro',
      countLiveAgentSessions: async () => 99,
      alreadyProvisioned: false,
    });

    expect(decision).toEqual({ allowed: false, reason: 'concurrency_limit' });
  });
});

/**
 * Tier eligibility overrides the resume exemption: a downgraded owner's
 * already-live sandbox must not keep resuming just because it was allocated
 * before the downgrade — this backstop is checked BEFORE `alreadyProvisioned`
 * is even consulted.
 */
describe('checkAgentSessionConcurrency — tier ineligibility overrides the resume exemption', () => {
  it('given a free-tier owner with an already-provisioned session, should still deny with tier_ineligible', async () => {
    const countLiveAgentSessions = vi.fn(async () => 0);

    const decision = await checkAgentSessionConcurrency({
      ownerId: 'user-1',
      tier: 'free',
      countLiveAgentSessions,
      alreadyProvisioned: true,
    });

    expect(decision).toEqual({ allowed: false, reason: 'tier_ineligible' });
    expect(countLiveAgentSessions).not.toHaveBeenCalled();
  });
});

describe('checkDriveEnvAllowance', () => {
  it('given an owned count under the tier ceiling, should allow', async () => {
    const decision = await checkDriveEnvAllowance({
      payerId: 'payer-1',
      tier: 'pro',
      countEnvsOwnedBy: async () => getDriveEnvLimit('pro') - 1,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('given an owned count AT the tier ceiling, should deny with env_limit_reached and name the limit', async () => {
    const decision = await checkDriveEnvAllowance({
      payerId: 'payer-1',
      tier: 'pro',
      countEnvsOwnedBy: async () => getDriveEnvLimit('pro'),
    });
    expect(decision).toEqual({ allowed: false, reason: 'env_limit_reached', limit: getDriveEnvLimit('pro') });
  });

  it('given a FREE-tier payer, should deny as tier_ineligible WITHOUT even counting — envs are a paid-tier feature', async () => {
    // Free's ceiling is 0, so a count-first implementation would also refuse —
    // but it would refuse with the wrong word (and a needless DB round-trip),
    // telling a free user they are "at their limit" of a feature they do not have.
    const countEnvsOwnedBy = vi.fn(async () => 0);
    const decision = await checkDriveEnvAllowance({ payerId: 'payer-1', tier: 'free', countEnvsOwnedBy });

    expect(decision).toEqual({ allowed: false, reason: 'tier_ineligible', limit: 0 });
    expect(countEnvsOwnedBy).not.toHaveBeenCalled();
  });

  it('should meter the PAYER it was handed — the drive owner, never the caller', async () => {
    const countEnvsOwnedBy = vi.fn(async () => 0);
    await checkDriveEnvAllowance({ payerId: 'drive-owner', tier: 'business', countEnvsOwnedBy });
    expect(countEnvsOwnedBy).toHaveBeenCalledWith('drive-owner');
  });

  it('should carry the documented per-tier ceilings — free 0 / pro 2 / founder 5 / business 10', () => {
    // The placeholder numbers pending the economics sign-off, pinned so a
    // silent retune is a test change rather than a billing surprise.
    expect([
      getDriveEnvLimit('free'),
      getDriveEnvLimit('pro'),
      getDriveEnvLimit('founder'),
      getDriveEnvLimit('business'),
    ]).toEqual([0, 2, 5, 10]);
  });

  it('given a tier whose ceiling is above the count, should allow at exactly one below', async () => {
    const decision = await checkDriveEnvAllowance({
      payerId: 'payer-1',
      tier: 'business',
      countEnvsOwnedBy: async () => getDriveEnvLimit('business') - 1,
    });
    expect(decision).toEqual({ allowed: true });
  });
});
