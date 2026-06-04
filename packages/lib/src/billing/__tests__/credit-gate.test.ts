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
    debtCents: 'cb.debt',
    monthlyPeriodStart: 'cb.periodStart',
    monthlyPeriodEnd: 'cb.periodEnd',
  },
  creditHolds: { id: 'ch.id', userId: 'ch.userId', estCents: 'ch.estCents', expiresAt: 'ch.expiresAt' },
  creditLedger: {
    userId: 'cl.userId',
    entryType: 'cl.entryType',
    chargeMillicents: 'cl.chargeMillicents',
    createdAt: 'cl.createdAt',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...a) => ({ op: 'and', a })),
  gt: vi.fn((a, b) => ({ op: 'gt', a, b })),
  gte: vi.fn((a, b) => ({ op: 'gte', a, b })),
  lt: vi.fn((a, b) => ({ op: 'lt', a, b })),
  or: vi.fn((...a) => ({ op: 'or', a })),
  isNull: vi.fn((a) => ({ op: 'isNull', a })),
  inArray: vi.fn((a, b) => ({ op: 'inArray', a, b })),
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

/**
 * Like {@link mockTransaction} but wires a THIRD select — the daily-cap charged-spend
 * aggregate (resolves at .from().where(), returning `{ chargedMc }`). Used by the
 * exposure-cap suite where a cap is configured so the allow path runs that query.
 */
function mockTransactionWithDailyCharge(
  balRow: Record<string, unknown> | null,
  holds: { reserved: number; inFlight: number },
  chargedMc: number,
  sink: { holdValues?: Record<string, unknown>; insertCalled?: boolean } = {},
  holdId = 'hold_1',
) {
  mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      select: vi.fn()
        .mockReturnValueOnce({ from: () => ({ where: () => ({ for: () => Promise.resolve(balRow ? [balRow] : []) }) }) })
        .mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve([{ reserved: holds.reserved, inFlight: holds.inFlight }]) }) })
        .mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve([{ chargedMc }]) }) }),
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
    // Placing the hold must NOT push a balance update: holds are hidden from the
    // displayed balance, and the navbar updates only when the call settles (real
    // cost) via consumeCredits. Emitting here would make the headline dip-then-pop.
    expect(mockEmitCreditsUpdated).not.toHaveBeenCalled();
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

  it('denies when outstanding debt drags net spendable to/under the floor', async () => {
    // monthly 100, topup 0, but 100 owed -> net 0 - est 25 < floor 25 -> out_of_credits.
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 100, topupRemainingCents: 0, debtCents: 100, monthlyPeriodEnd: FUTURE }]));
    const sink: { insertCalled?: boolean } = {};
    mockTransaction({ monthlyRemainingCents: 100, topupRemainingCents: 0, debtCents: 100, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 }, sink);

    const r = await canConsumeAI('u1', 'pro');

    expect(r).toMatchObject({ allowed: false, reason: 'out_of_credits' });
    expect(sink.insertCalled).toBeFalsy();
  });

  it('allows when the buckets still clear the floor net of a smaller debt', async () => {
    // monthly 200, topup 0, debt 100 -> net 100 - est 25 = 75 > floor 25 -> ok.
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 200, topupRemainingCents: 0, debtCents: 100, monthlyPeriodEnd: FUTURE }]));
    mockTransaction({ monthlyRemainingCents: 200, topupRemainingCents: 0, debtCents: 100, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'pro');
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok');
  });

  it('forgives outstanding debt at the gate-driven free reset (debtCents -> 0, full allowance)', async () => {
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, debtCents: 300, monthlyPeriodEnd: PAST }]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 500, topupRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { set?: Record<string, unknown> } = {};
    mockDb.update.mockReturnValue(updateCapturing(sink));
    mockTransaction({ monthlyRemainingCents: 500, topupRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'free');

    // Renewal restores the FULL allowance AND wipes the debt.
    expect(sink.set).toMatchObject({ monthlyRemainingCents: 500, monthlyAllowanceCents: 500, debtCents: 0 });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok');
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

  it('accumulates: carries the remaining balance into the new period when resetting (free, gate-driven rollover)', async () => {
    // 200 remaining when the period expired → 200 carried + 500 allowance = 700.
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 200, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 700, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { set?: Record<string, unknown> } = {};
    mockDb.update.mockReturnValue(updateCapturing(sink));
    mockTransaction({ monthlyRemainingCents: 700, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'free');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(sink.set).toMatchObject({ monthlyRemainingCents: 700, monthlyAllowanceCents: 500 });
    expect(r.allowed).toBe(true);
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

describe('canConsumeAI — per-user/day exposure cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBillingEnabled.mockReturnValue(true);
    mockDb.insert.mockReturnValue(insertChain());
    // A user with plenty of credits so the credit gate always allows — isolating the
    // daily-cap decision. selectReturning feeds the pre-transaction lazy-init read.
    mockDb.select.mockReturnValue(
      selectReturning([{ monthlyRemainingCents: 100_000, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]),
    );
  });

  afterEach(() => {
    delete process.env.CREDITS_ENFORCEMENT_ENABLED;
    delete process.env.DAILY_USER_EXPOSURE_CAP_CENTS;
    delete process.env.DAILY_CAP_BUSINESS_CENTS;
  });

  const BAL = { monthlyRemainingCents: 100_000, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE };

  it('denies (429-mapped) when the day spend + this call exceeds the cap, with enforcement ON', async () => {
    process.env.CREDITS_ENFORCEMENT_ENABLED = 'true';
    process.env.DAILY_USER_EXPOSURE_CAP_CENTS = '500';
    // 480¢ already charged today (480_000 millicents) + EST(25) = 505 > 500 → deny.
    const sink: { insertCalled?: boolean } = {};
    mockTransactionWithDailyCharge(BAL, { reserved: 0, inFlight: 0 }, 480_000, sink);

    const r = await canConsumeAI('u1', 'pro');

    expect(r).toEqual({ allowed: false, reason: 'daily_cap_exceeded' });
    // No hold is reserved on a cap denial.
    expect(sink.insertCalled).toBeFalsy();
  });

  it('allows + reserves a hold when the day spend stays under the cap', async () => {
    process.env.CREDITS_ENFORCEMENT_ENABLED = 'true';
    process.env.DAILY_USER_EXPOSURE_CAP_CENTS = '500';
    const sink: { insertCalled?: boolean } = {};
    mockTransactionWithDailyCharge(BAL, { reserved: 0, inFlight: 0 }, 100_000, sink); // 100¢ + 25 < 500

    const r = await canConsumeAI('u1', 'pro');

    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok');
    expect(sink.insertCalled).toBe(true);
  });

  it('is SOFT: a cap denial is downgraded to enforcement_disabled while dark-launched (OFF)', async () => {
    // enforcement OFF (deleted in afterEach / unset here)
    process.env.DAILY_USER_EXPOSURE_CAP_CENTS = '500';
    const sink: { insertCalled?: boolean } = {};
    mockTransactionWithDailyCharge(BAL, { reserved: 0, inFlight: 0 }, 480_000, sink);

    const r = await canConsumeAI('u1', 'pro');

    expect(r).toEqual({ allowed: true, reason: 'enforcement_disabled' });
    expect(sink.insertCalled).toBeFalsy(); // still no hold on the (downgraded) denial
  });

  it('counts active in-flight hold reservations toward the cap (burst cannot exceed it)', async () => {
    process.env.CREDITS_ENFORCEMENT_ENABLED = 'true';
    process.env.DAILY_USER_EXPOSURE_CAP_CENTS = '500';
    // Settled 100¢ today, but 450¢ of holds are still in flight (not yet in the ledger):
    // 100 + 450 + EST(25) = 575 > 500 → deny, even though settled alone (125) is under.
    const sink: { insertCalled?: boolean } = {};
    mockTransactionWithDailyCharge(BAL, { reserved: 450, inFlight: 3 }, 100_000, sink);

    const r = await canConsumeAI('u1', 'pro');

    expect(r).toEqual({ allowed: false, reason: 'daily_cap_exceeded' });
    expect(sink.insertCalled).toBeFalsy();
  });

  it('respects a per-tier override (DAILY_CAP_BUSINESS_CENTS) above the global cap', async () => {
    process.env.CREDITS_ENFORCEMENT_ENABLED = 'true';
    process.env.DAILY_USER_EXPOSURE_CAP_CENTS = '500';
    process.env.DAILY_CAP_BUSINESS_CENTS = '1000';
    // 600¢ today + 25 = 625: over the global 500 but under the business 1000 → allowed.
    const sink: { insertCalled?: boolean } = {};
    mockTransactionWithDailyCharge(BAL, { reserved: 0, inFlight: 0 }, 600_000, sink);

    const r = await canConsumeAI('u1', 'business');

    expect(r.allowed).toBe(true);
    expect(sink.insertCalled).toBe(true);
  });

  it('counts the full intended charge (chargeMillicents, usage+adjustment) — query shape locked', async () => {
    process.env.CREDITS_ENFORCEMENT_ENABLED = 'true';
    process.env.DAILY_USER_EXPOSURE_CAP_CENTS = '500';
    mockTransactionWithDailyCharge(BAL, { reserved: 0, inFlight: 0 }, 100_000);

    await canConsumeAI('u1', 'pro');

    const { inArray } = await import('@pagespace/db/operators');
    // The daily-cap query scopes to usage + adjustment rows (chargeMillicents is set on
    // those; NULL elsewhere) so an in-debt user's full charge still counts.
    expect(inArray).toHaveBeenCalledWith('cl.entryType', ['usage', 'adjustment']);
  });

  it('bypasses the cap entirely when skipDailyCap is set (system caller)', async () => {
    process.env.CREDITS_ENFORCEMENT_ENABLED = 'true';
    process.env.DAILY_USER_EXPOSURE_CAP_CENTS = '500';
    // Even with a charged total that WOULD exceed the cap, skipDailyCap skips the check.
    const sink: { insertCalled?: boolean } = {};
    mockTransactionWithDailyCharge(BAL, { reserved: 0, inFlight: 0 }, 480_000, sink);

    const r = await canConsumeAI('u1', 'pro', { skipDailyCap: true });

    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok');
    expect(sink.insertCalled).toBe(true);
  });

  it('no cap configured (default) → never runs the daily-cap query, allows normally', async () => {
    process.env.CREDITS_ENFORCEMENT_ENABLED = 'true';
    // DAILY_USER_EXPOSURE_CAP_CENTS unset → cap disabled. Use the 2-select transaction;
    // a 3rd select would throw if the cap path ran.
    const sink: { insertCalled?: boolean } = {};
    mockTransaction(BAL, { reserved: 0, inFlight: 0 }, sink);

    const r = await canConsumeAI('u1', 'pro');

    expect(r.allowed).toBe(true);
    expect(sink.insertCalled).toBe(true);
  });
});
