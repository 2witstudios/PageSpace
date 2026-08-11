import { describe, it, expect, vi, beforeEach } from 'vitest';

// MACHINE_MARKUP_BPS is computed at module-import time from an env var, so
// each test re-imports the module with different env conditions (same
// pattern as auth/__tests__/constants.test.ts).

describe('MACHINE_MARKUP_BPS floor clamp', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.MACHINE_MARKUP_BPS;
    delete process.env.CREDIT_MARKUP_BPS;
  });

  it('defaults to the 15000bps (1.5x) floor when unset', async () => {
    const { MACHINE_MARKUP_BPS, MACHINE_MARKUP_FLOOR_BPS } = await import('../credit-pricing');
    expect(MACHINE_MARKUP_BPS).toBe(15000);
    expect(MACHINE_MARKUP_FLOOR_BPS).toBe(15000);
  });

  it('clamps UP to the floor when the env var is set below it (misconfiguration guard)', async () => {
    // The exact scenario Codex flagged: an env typo or someone mirroring a
    // reduced AI markup must not be able to silently violate the 1.5x floor.
    process.env.MACHINE_MARKUP_BPS = '5000';
    const { MACHINE_MARKUP_BPS } = await import('../credit-pricing');
    expect(MACHINE_MARKUP_BPS).toBe(15000);
  });

  it('clamps a zero env value up to the floor', async () => {
    process.env.MACHINE_MARKUP_BPS = '0';
    const { MACHINE_MARKUP_BPS } = await import('../credit-pricing');
    expect(MACHINE_MARKUP_BPS).toBe(15000);
  });

  it('passes through a deliberately HIGHER markup unclamped (no ceiling)', async () => {
    process.env.MACHINE_MARKUP_BPS = '20000';
    const { MACHINE_MARKUP_BPS } = await import('../credit-pricing');
    expect(MACHINE_MARKUP_BPS).toBe(20000);
  });

  it('is independent of CREDIT_MARKUP_BPS — lowering the shared AI markup does not move the terminal floor', async () => {
    process.env.CREDIT_MARKUP_BPS = '5000';
    const { MACHINE_MARKUP_BPS, MARKUP_BPS } = await import('../credit-pricing');
    expect(MARKUP_BPS).toBe(5000);
    expect(MACHINE_MARKUP_BPS).toBe(15000);
  });
});

describe('realtime session constants', () => {
  const KEYS = [
    'REALTIME_SESSION_HOLD_ESTIMATE_CENTS',
    'REALTIME_MAX_SESSION_SECONDS',
    'REALTIME_IDLE_TIMEOUT_SECONDS',
    'REALTIME_MAX_INFLIGHT',
    'REALTIME_MAX_GLOBAL_SESSIONS',
    'CREDIT_HOLD_TTL_SECONDS',
  ];

  beforeEach(() => {
    vi.resetModules();
    for (const key of KEYS) delete process.env[key];
  });

  it('defaults: 10c hold, 600s max session, 120s idle, 2 per user, 8 global', async () => {
    const c = await import('../credit-pricing');
    expect(c.REALTIME_SESSION_HOLD_ESTIMATE_CENTS).toBe(10);
    expect(c.REALTIME_MAX_SESSION_SECONDS).toBe(600);
    expect(c.REALTIME_IDLE_TIMEOUT_SECONDS).toBe(120);
    expect(c.REALTIME_MAX_INFLIGHT).toBe(2);
    expect(c.REALTIME_MAX_GLOBAL_SESSIONS).toBe(8);
  });

  it('keeps a session shorter than the hold TTL, so the reconcile cron cannot sweep a live call', async () => {
    // The load-bearing invariant behind REALTIME_MAX_SESSION_SECONDS' default: a
    // session that outlived CREDIT_HOLD_TTL_SECONDS would have its own reservation
    // reclaimed mid-call. Raising the cap requires raising the TTL in the same change.
    const { REALTIME_MAX_SESSION_SECONDS, CREDIT_HOLD_TTL_SECONDS } = await import(
      '../credit-pricing'
    );
    expect(REALTIME_MAX_SESSION_SECONDS).toBeLessThan(CREDIT_HOLD_TTL_SECONDS);
    // ...with a real settle margin, not merely one second under.
    expect(CREDIT_HOLD_TTL_SECONDS - REALTIME_MAX_SESSION_SECONDS).toBeGreaterThanOrEqual(300);
  });

  it('reaps an idle session well before the hard duration cap fires', async () => {
    const { REALTIME_IDLE_TIMEOUT_SECONDS, REALTIME_MAX_SESSION_SECONDS } = await import(
      '../credit-pricing'
    );
    expect(REALTIME_IDLE_TIMEOUT_SECONDS).toBeLessThan(REALTIME_MAX_SESSION_SECONDS);
  });

  it('caps global concurrency at or under what 40,000 tokens/min supports', async () => {
    // PROVEN: the OpenAI account is limited to 40k tokens/min across ALL sessions on
    // our key. A continuously-talking session burns roughly 4k tokens/min, so the
    // global cap must stay at or below ~10 or we throttle calls already in progress.
    const { REALTIME_MAX_GLOBAL_SESSIONS } = await import('../credit-pricing');
    expect(REALTIME_MAX_GLOBAL_SESSIONS).toBeLessThanOrEqual(40_000 / 4_000);
    expect(REALTIME_MAX_GLOBAL_SESSIONS).toBeGreaterThan(0);
  });

  it('allows more than one session per user so a zombie session is not a lockout', async () => {
    const { REALTIME_MAX_INFLIGHT, REALTIME_MAX_GLOBAL_SESSIONS } = await import(
      '../credit-pricing'
    );
    expect(REALTIME_MAX_INFLIGHT).toBeGreaterThanOrEqual(2);
    expect(REALTIME_MAX_INFLIGHT).toBeLessThan(REALTIME_MAX_GLOBAL_SESSIONS);
  });

  it('takes env overrides, and ignores garbage in favour of the documented default', async () => {
    process.env.REALTIME_MAX_SESSION_SECONDS = '300';
    process.env.REALTIME_MAX_GLOBAL_SESSIONS = 'nope';
    const { REALTIME_MAX_SESSION_SECONDS, REALTIME_MAX_GLOBAL_SESSIONS } = await import(
      '../credit-pricing'
    );
    expect(REALTIME_MAX_SESSION_SECONDS).toBe(300);
    expect(REALTIME_MAX_GLOBAL_SESSIONS).toBe(8);
  });
});
