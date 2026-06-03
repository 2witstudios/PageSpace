import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockIsBillingEnabled = vi.hoisted(() => vi.fn(() => true));
const mockDb = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), update: vi.fn(), transaction: vi.fn() }));

vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/schema/credits', () => ({
  creditBalances: {
    userId: 'cb.userId',
    monthlyRemainingCents: 'cb.monthly',
    topupRemainingCents: 'cb.topup',
    monthlyAllowanceCents: 'cb.allowance',
    monthlyPeriodStart: 'cb.periodStart',
    monthlyPeriodEnd: 'cb.periodEnd',
  },
  creditHolds: { id: 'ch.id', userId: 'ch.userId', estCents: 'ch.estCents', expiresAt: 'ch.expiresAt' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...a) => ({ op: 'and', a })),
  gt: vi.fn((a, b) => ({ op: 'gt', a, b })),
  lt: vi.fn((a, b) => ({ op: 'lt', a, b })),
  or: vi.fn((...a) => ({ op: 'or', a })),
  isNull: vi.fn((a) => ({ op: 'isNull', a })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: true, strings, values })),
}));
vi.mock('../../deployment-mode', () => ({ isBillingEnabled: mockIsBillingEnabled }));
const mockEmitCreditsUpdated = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../credit-emit', () => ({ emitCreditsUpdated: mockEmitCreditsUpdated }));

import { canConsumeAI, addOneMonth } from '../credit-gate';

// Default pricing (unmocked credit-pricing): RESERVE_FLOOR_CENTS = 25,
// CREDIT_HOLD_ESTIMATE_CENTS = 25 (defaults to the floor), MAX_FREE_INFLIGHT = 2.
const EST = 25;

describe('addOneMonth', () => {
  const at = (iso: string) => new Date(iso);

  it('advances a mid-month date by one calendar month, preserving time-of-day', () => {
    expect(addOneMonth(at('2026-01-15T08:30:00.000Z')).toISOString()).toBe('2026-02-15T08:30:00.000Z');
  });

  it('clamps a month-end start to the last valid day instead of overflowing', () => {
    expect(addOneMonth(at('2026-01-31T00:00:00.000Z')).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addOneMonth(at('2026-03-31T12:00:00.000Z')).toISOString()).toBe('2026-04-30T12:00:00.000Z');
  });

  it('clamps to Feb 29 in a leap year', () => {
    expect(addOneMonth(at('2028-01-31T00:00:00.000Z')).toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('rolls over the year for a December start', () => {
    expect(addOneMonth(at('2026-12-31T00:00:00.000Z')).toISOString()).toBe('2027-01-31T00:00:00.000Z');
  });
});

// ── Chain builders ───────────────────────────────────────────────────────────
function selectReturning(rows: unknown[]) {
  return { from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) };
}
function insertChain() {
  return { values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }) };
}
function updateCapturing(sink: { set?: Record<string, unknown> }) {
  return { set: (v: Record<string, unknown>) => { sink.set = v; return { where: () => Promise.resolve(undefined) }; } };
}

/**
 * Wire mockDb.transaction to run its callback against a fake tx. `balRow` is the
 * locked balance read; `holds` controls the reserved/inFlight aggregate. Captures
 * any inserted hold values and returns a stubbed id.
 */
function mockTransaction(
  balRow: Record<string, unknown> | null,
  holds: { reserved: number; inFlight: number },
  sink: { holdValues?: Record<string, unknown>; insertCalled?: boolean } = {},
  holdId = 'hold_1',
) {
  mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      select: vi.fn()
        // 1st select: balance row lock -> .for('update')
        .mockReturnValueOnce({ from: () => ({ where: () => ({ for: () => Promise.resolve(balRow ? [balRow] : []) }) }) })
        // 2nd select: hold aggregate -> resolves at .where
        .mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve([{ reserved: holds.reserved, inFlight: holds.inFlight }]) }) }),
      insert: vi.fn(() => {
        sink.insertCalled = true;
        return {
          values: (v: Record<string, unknown>) => {
            sink.holdValues = v;
            return { returning: () => Promise.resolve([{ id: holdId }]) };
          },
        };
      }),
    };
    return cb(tx);
  });
}

const PAST = new Date(Date.now() - 60 * 60 * 1000);
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

describe('canConsumeAI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBillingEnabled.mockReturnValue(true);
    mockDb.insert.mockReturnValue(insertChain());
    // These assertions exercise ENFORCEMENT (the 402/429 blocking). The flag
    // defaults OFF (dark launch), so turn it on for the enforcement suite; the
    // dark-launch behavior is covered in its own describe block below.
    process.env.CREDITS_ENFORCEMENT_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.CREDITS_ENFORCEMENT_ENABLED;
  });

  it('allows unconditionally when billing is disabled (tenant/onprem)', async () => {
    mockIsBillingEnabled.mockReturnValue(false);
    const r = await canConsumeAI('u1', 'free');
    expect(r).toEqual({ allowed: true, reason: 'unlimited' });
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('allows a user with spendable credits and returns a holdId', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 100, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { holdValues?: Record<string, unknown> } = {};
    mockTransaction({ monthlyRemainingCents: 100, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 }, sink);

    const r = await canConsumeAI('u1', 'pro');

    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok');
    expect(r.holdId).toBe('hold_1');
    // The hold reserves this call's estimate and is scoped to the user.
    expect(sink.holdValues).toMatchObject({ userId: 'u1', estCents: EST });
    expect(sink.holdValues?.expiresAt).toBeInstanceOf(Date);
    // Placing the hold shrank spendable -> push the fresh balance so the navbar
    // drops the instant the call starts (not just when it settles).
    expect(mockEmitCreditsUpdated).toHaveBeenCalledWith('u1');
  });

  it('caps a PAID user via opts.maxInFlight (voice concurrency bound) even with ample credit', async () => {
    // Paid tiers are normally uncapped on concurrency; the voice routes pass a cap to
    // bound concurrent paid voice spend. 4 holds already in flight == the cap → deny.
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 100000, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { insertCalled?: boolean } = {};
    mockTransaction({ monthlyRemainingCents: 100000, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 8, inFlight: 4 }, sink);

    const r = await canConsumeAI('u1', 'pro', { estCostCents: 2, maxInFlight: 4 });

    expect(r).toMatchObject({ allowed: false, reason: 'too_many_in_flight' });
    expect(sink.insertCalled).toBeFalsy();
  });

  it('reserves the estCostCents override (voice) instead of the chat default', async () => {
    // Voice routes pass a small per-call estimate so a sub-cent STT/TTS call doesn't
    // reserve the full 25¢ chat hold. The hold must reflect the override.
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 100, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { holdValues?: Record<string, unknown> } = {};
    mockTransaction({ monthlyRemainingCents: 100, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 }, sink);

    const r = await canConsumeAI('u1', 'pro', { estCostCents: 2 });

    expect(r.allowed).toBe(true);
    expect(sink.holdValues).toMatchObject({ userId: 'u1', estCents: 2 });
  });

  it('denies with out_of_credits when both buckets are empty (no hold inserted)', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { insertCalled?: boolean } = {};
    mockTransaction({ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 }, sink);

    const r = await canConsumeAI('u1', 'pro');

    expect(r).toMatchObject({ allowed: false, reason: 'out_of_credits' });
    expect(r.holdId).toBeUndefined();
    expect(sink.insertCalled).toBeFalsy();
    // No hold created -> nothing changed -> no push.
    expect(mockEmitCreditsUpdated).not.toHaveBeenCalled();
  });

  it('denies a free user who has reached the in-flight cap (too_many_in_flight), even with credit', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { insertCalled?: boolean } = {};
    // 2 holds already in flight == MAX_FREE_INFLIGHT.
    mockTransaction({ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 50, inFlight: 2 }, sink);

    const r = await canConsumeAI('u1', 'free');

    expect(r).toMatchObject({ allowed: false, reason: 'too_many_in_flight' });
    expect(sink.insertCalled).toBeFalsy();
  });

  it('does NOT cap a paid user on concurrency (many in-flight holds still allowed)', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 10000, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    mockTransaction({ monthlyRemainingCents: 10000, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 250, inFlight: 10 });

    const r = await canConsumeAI('u1', 'pro');
    expect(r.allowed).toBe(true);
  });

  it('denies when outstanding holds reserve enough to push spendable to the floor', async () => {
    // monthly 80, floor 25, est 25. Reserved 50 from prior holds:
    // 80 - 50 - 25 = 5 <= 25 -> out_of_credits.
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 80, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    mockTransaction({ monthlyRemainingCents: 80, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 50, inFlight: 1 });

    const r = await canConsumeAI('u1', 'pro');
    expect(r).toMatchObject({ allowed: false, reason: 'out_of_credits' });
  });

  it('lazy-inits a balance row from tier defaults on first request, then allows with a hold', async () => {
    // 1st select: no row. After insert, the transaction's locked read sees the persisted row.
    mockDb.select.mockReturnValueOnce(selectReturning([]));
    let initValues: Record<string, unknown> | undefined;
    mockDb.insert.mockReturnValue({
      values: (v: Record<string, unknown>) => { initValues = v; return { onConflictDoNothing: () => Promise.resolve(undefined) }; },
    });
    mockTransaction({ monthlyRemainingCents: 1500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'pro');

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(initValues?.monthlyPeriodStart).toBeInstanceOf(Date);
    expect(initValues?.monthlyPeriodEnd).toBeInstanceOf(Date);
    expect(r.allowed).toBe(true);
    expect(r.holdId).toBe('hold_1');
  });

  it('re-evaluates against the persisted (drained) row after a concurrent init — no false allow', async () => {
    mockDb.select.mockReturnValueOnce(selectReturning([]));
    mockDb.insert.mockReturnValue(insertChain());
    // The locked read inside the transaction sees an empty balance (a racing request drained it).
    mockTransaction({ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'pro');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('out_of_credits');
  });

  it('resets the monthly bucket to the tier allowance when the period has expired (free, gate-driven)', async () => {
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { set?: Record<string, unknown> } = {};
    mockDb.update.mockReturnValue(updateCapturing(sink));
    mockTransaction({ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'free');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(sink.set).toMatchObject({ monthlyRemainingCents: 500, monthlyAllowanceCents: 500 });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok');
  });

  it('grants the monthly allowance and stamps a window when a top-up created the row without a period', async () => {
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 2500, monthlyPeriodEnd: null }]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 500, topupRemainingCents: 2500, monthlyPeriodEnd: FUTURE }]));
    const sink: { set?: Record<string, unknown> } = {};
    mockDb.update.mockReturnValue(updateCapturing(sink));
    mockTransaction({ monthlyRemainingCents: 500, topupRemainingCents: 2500, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'free');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(sink.set).toMatchObject({ monthlyRemainingCents: 500, monthlyAllowanceCents: 500 });
    expect(r.allowed).toBe(true);
  });

  it('does NOT gate-reset a paid user with an expired window — invoice.paid is authoritative', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]));
    mockTransaction({ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'pro');
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(r).toMatchObject({ allowed: false, reason: 'out_of_credits' });
  });

  it('does NOT count a paid user\'s leftover monthly as spendable once the window has expired', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 300, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]));
    mockTransaction({ monthlyRemainingCents: 300, topupRemainingCents: 0, monthlyPeriodEnd: PAST }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'pro');
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(r).toMatchObject({ allowed: false, reason: 'out_of_credits' });
  });

  it('still counts a paid user\'s top-up bucket when the monthly window has expired', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 300, topupRemainingCents: 1000, monthlyPeriodEnd: PAST }]));
    mockTransaction({ monthlyRemainingCents: 300, topupRemainingCents: 1000, monthlyPeriodEnd: PAST }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'pro');
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok');
  });

  it('does NOT reset when the period is still active', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 800, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    mockTransaction({ monthlyRemainingCents: 800, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'free');
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(r.allowed).toBe(true);
  });
});

describe('canConsumeAI — dark launch (CREDITS_ENFORCEMENT_ENABLED off, the default)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBillingEnabled.mockReturnValue(true);
    mockDb.insert.mockReturnValue(insertChain());
    delete process.env.CREDITS_ENFORCEMENT_ENABLED; // default OFF — meter, don't block
  });

  it('does NOT block an out-of-credits user — overrides the denial to allowed:enforcement_disabled', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    mockTransaction({ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'pro');

    // The gate still did its bookkeeping (the locked transaction ran) — dark launch
    // is NOT a short-circuit — but the would-be out_of_credits denial is suppressed.
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(r).toEqual({ allowed: true, reason: 'enforcement_disabled' });
  });

  it('does NOT enforce the free in-flight cap — overrides too_many_in_flight to allowed', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    // 2 holds in flight == MAX_FREE_INFLIGHT -> would be too_many_in_flight when enforced.
    mockTransaction({ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 50, inFlight: 2 });

    const r = await canConsumeAI('u1', 'free');

    expect(r).toEqual({ allowed: true, reason: 'enforcement_disabled' });
  });

  it('leaves a credit-having user UNCHANGED — normal allow + hold, not the dark-launch override', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 100, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    mockTransaction({ monthlyRemainingCents: 100, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'pro');

    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok'); // not 'enforcement_disabled' — the override only flips denials
    expect(r.holdId).toBe('hold_1');
  });
});
