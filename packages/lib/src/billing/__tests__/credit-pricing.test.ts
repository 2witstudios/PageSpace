import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// MACHINE_MARKUP_BPS is computed at module-import time from an env var, so
// each test re-imports the module with different env conditions (same
// pattern as auth/__tests__/constants.test.ts).

describe('MACHINE_MARKUP_BPS floor clamp', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.MACHINE_MARKUP_BPS;
    delete process.env.CREDIT_MARKUP_BPS;
  });

  // lib vitest runs files sequentially in ONE forked process (pool: 'forks',
  // fileParallelism: false), so process.env leaks into the next file. The
  // last test here leaves CREDIT_MARKUP_BPS='5000' set; chat-pricing.ts reads
  // MARKUP_BPS at import and its test then sees 5 instead of 15.
  afterEach(() => {
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

  afterEach(() => {
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

describe('TIER_ALLOWANCE_REFILLS', () => {
  it('names every tier, and only the free tier is a one-time (non-refilling) grant', async () => {
    const { TIER_ALLOWANCE_REFILLS } = await import('../credit-pricing');
    const { TIERS } = await import('../subscription-tiers');
    expect(Object.keys(TIER_ALLOWANCE_REFILLS).sort()).toEqual([...TIERS].sort());
    expect(TIER_ALLOWANCE_REFILLS.free).toBe(false);
    expect(TIER_ALLOWANCE_REFILLS.pro).toBe(true);
    expect(TIER_ALLOWANCE_REFILLS.business).toBe(true);
  });

  it('MON-1 (partial) credit-pricing no longer tabulates an allowance — the money model derives it', async () => {
    const pricing: Record<string, unknown> = await import('../credit-pricing');
    expect(pricing.TIER_MONTHLY_ALLOWANCE_CENTS).toBeUndefined();
  });
});

describe('allowanceRefills / isOneTimeAllowanceTier', () => {
  it('free is a one-time tier and does not refill; paid tiers refill and are not one-time', async () => {
    const { allowanceRefills, isOneTimeAllowanceTier } = await import('../credit-pricing');
    expect(allowanceRefills('free')).toBe(false);
    expect(isOneTimeAllowanceTier('free')).toBe(true);
    for (const tier of ['pro', 'business']) {
      expect(allowanceRefills(tier)).toBe(true);
      expect(isOneTimeAllowanceTier(tier)).toBe(false);
    }
  });

  it('an unknown/legacy tier string is NEITHER refilling NOR one-time — nothing is granted or pre-credited for it', async () => {
    // users.subscriptionTier reaches callers as an unchecked string; a legacy value
    // like 'normal' must not be mistaken for the free tier's starter grant.
    const { allowanceRefills, isOneTimeAllowanceTier } = await import('../credit-pricing');
    expect(allowanceRefills('normal')).toBe(false);
    expect(isOneTimeAllowanceTier('normal')).toBe(false);
  });
});

// The no-invoice allowance per tier (MON-2): money-model's tierAllowanceCents is the one
// definition, so these tests read it rather than a tier table.
async function tierAllowances(): Promise<{ free: number; pro: number; business: number }> {
  const { tierAllowanceCents } = await import('../money-model');
  return { free: tierAllowanceCents('free'), pro: tierAllowanceCents('pro'), business: tierAllowanceCents('business') };
}

describe('starterGrantCents (ADR 0008 Decision 9 — no starter grant for agents)', () => {
  it('is 0 for an agent on the free tier', async () => {
    const { starterGrantCents } = await import('../credit-pricing');
    expect(starterGrantCents({ tier: 'free', accountType: 'agent' })).toBe(0);
  });

  it('is 0 for an agent on EVERY tier, including an unknown tier', async () => {
    const { starterGrantCents } = await import('../credit-pricing');
    const allowances = await tierAllowances();
    for (const tier of Object.keys(allowances)) {
      expect(starterGrantCents({ tier, accountType: 'agent' })).toBe(0);
    }
    expect(starterGrantCents({ tier: 'legacy-tier', accountType: 'agent' })).toBe(0);
  });

  it('is the free allowance for a human on the free tier', async () => {
    const { starterGrantCents } = await import('../credit-pricing');
    const allowances = await tierAllowances();
    expect(starterGrantCents({ tier: 'free', accountType: 'human' })).toBe(allowances.free);
    expect(starterGrantCents({ tier: 'free', accountType: 'human' })).toBe(500);
  });

  it('is the tier allowance for a human on a known tier (the gate’s existing lazy-init amount)', async () => {
    const { starterGrantCents } = await import('../credit-pricing');
    const allowances = await tierAllowances();
    expect(starterGrantCents({ tier: 'pro', accountType: 'human' })).toBe(allowances.pro);
    expect(starterGrantCents({ tier: 'business', accountType: 'human' })).toBe(allowances.business);
  });

  it('falls back to the free allowance for a human on an unknown tier (matches the gate’s `?? free`)', async () => {
    const { starterGrantCents } = await import('../credit-pricing');
    const allowances = await tierAllowances();
    expect(starterGrantCents({ tier: 'legacy-tier', accountType: 'human' })).toBe(allowances.free);
  });

  it('does not pick up prototype keys as tiers', async () => {
    const { starterGrantCents } = await import('../credit-pricing');
    const allowances = await tierAllowances();
    expect(starterGrantCents({ tier: 'toString', accountType: 'human' })).toBe(allowances.free);
  });
});

describe('allowanceGrantCents (Phase 1b — ONE allowance function for every grant)', () => {
  it('given an agent, should grant 0 for both a starter grant and a refill, on every tier', async () => {
    const { allowanceGrantCents } = await import('../credit-pricing');
    const allowances = await tierAllowances();
    for (const kind of ['starter', 'refill'] as const) {
      for (const tier of [...Object.keys(allowances), 'legacy-tier']) {
        expect(allowanceGrantCents({ tier, accountType: 'agent', kind })).toBe(0);
      }
    }
  });

  it('given a human refill on a known tier, should grant that tier allowance', async () => {
    const { allowanceGrantCents } = await import('../credit-pricing');
    const allowances = await tierAllowances();
    expect(allowanceGrantCents({ tier: 'pro', accountType: 'human', kind: 'refill' })).toBe(allowances.pro);
    expect(allowanceGrantCents({ tier: 'business', accountType: 'human', kind: 'refill' })).toBe(allowances.business);
  });

  it('given a human on an unknown or prototype-key tier, should fall back to the free allowance (both kinds)', async () => {
    const { allowanceGrantCents } = await import('../credit-pricing');
    const allowances = await tierAllowances();
    expect(allowanceGrantCents({ tier: 'legacy-tier', accountType: 'human', kind: 'refill' })).toBe(allowances.free);
    expect(allowanceGrantCents({ tier: 'toString', accountType: 'human', kind: 'starter' })).toBe(allowances.free);
  });

  it('given any input, starterGrantCents should equal the starter kind (it delegates)', async () => {
    const { allowanceGrantCents, starterGrantCents } = await import('../credit-pricing');
    for (const accountType of ['human', 'agent'] as const) {
      for (const tier of ['free', 'pro', 'business', 'legacy-tier']) {
        expect(starterGrantCents({ tier, accountType })).toBe(allowanceGrantCents({ tier, accountType, kind: 'starter' }));
      }
    }
  });
});
