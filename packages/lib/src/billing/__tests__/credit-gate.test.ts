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
    bucket: 'cl.bucket',
    amountCents: 'cl.amountCents',
    chargeMillicents: 'cl.chargeMillicents',
    stripeRef: 'cl.stripeRef',
    consumeStatus: 'cl.consumeStatus',
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

/**
 * Mock the lazy-init transaction (first db.transaction call when no balance row exists).
 * Captures the values passed to both tx.insert calls (balance and ledger).
 * `balanceCreated` controls whether the balance insert's .returning() reports a new row
 * (true = this call created it; false = concurrent path already created it, insert was a no-op).
 */
function mockLazyInitTransaction(
  sink: { balanceValues?: Record<string, unknown>; ledgerValues?: Record<string, unknown> } = {},
  balanceCreated = true,
) {
  let insertCount = 0;
  mockDb.transaction.mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insert: vi.fn(() => {
        insertCount++;
        const callNum = insertCount;
        return {
          values: (v: Record<string, unknown>) => {
            if (callNum === 1) sink.balanceValues = v;
            else sink.ledgerValues = v;
            return {
              onConflictDoNothing: () => ({
                returning: () => Promise.resolve(
                  callNum === 1 && balanceCreated ? [{ userId: 'u1' }] : [],
                ),
              }),
            };
          },
        };
      }),
    };
    return cb(tx);
  });
}

/**
 * Mock the reset transaction (first db.transaction call when the period has expired).
 * The fixed transaction re-reads the balance under `FOR UPDATE` INSIDE the txn and
 * computes the refill from THAT locked row — never from the unlocked pre-read. The
 * `lockedRow` argument is what that in-transaction `select(...).for('update')`
 * resolves to; it is the source of truth for the refill arithmetic, so a test can
 * make it diverge from the pre-read snapshot to prove the ordering. A null/empty
 * `lockedRow` (or one whose window is no longer expired) models a concurrent reset
 * that already rolled the window forward: the fix must skip the UPDATE + ledger write.
 * Captures the set payload and ledger values.
 */
function mockResetTransaction(
  sink: { set?: Record<string, unknown>; ledgerValues?: Record<string, unknown>; updateCalled?: boolean } = {},
  lockedRow: Record<string, unknown> | null = null,
  // Rows the IN-TRANSACTION subscription re-check resolves to (paid tiers only;
  // `.limit()` chain). Non-empty models a subscription that appeared between the
  // unlocked pre-check and the grant — the reset must abort.
  txSubscriptionRows: Record<string, unknown>[] = [],
) {
  mockDb.transaction.mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            for: () => Promise.resolve(lockedRow ? [lockedRow] : []),
            limit: () => Promise.resolve(txSubscriptionRows),
          }),
        }),
      })),
      update: vi.fn(() => {
        sink.updateCalled = true;
        return {
          set: (v: Record<string, unknown>) => {
            sink.set = v;
            // The fixed UPDATE targets by userId only (the row lock + post-lock predicate
            // recheck handle the race), so it is awaited directly. Expose a thenable that
            // also answers .returning() so a pre-fix implementation calling .returning()
            // surfaces a clean assertion mismatch rather than a TypeError.
            return {
              where: () => ({
                returning: () => Promise.resolve([{ userId: 'ignored' }]),
                then: (resolve: (v: unknown) => unknown) => resolve(undefined),
              }),
            };
          },
        };
      }),
      insert: vi.fn(() => ({
        values: (v: Record<string, unknown>) => {
          sink.ledgerValues = v;
          return { onConflictDoNothing: () => Promise.resolve(undefined) };
        },
      })),
    };
    return cb(tx);
  });
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

  it('nets outstanding debt against carry at gate-driven free reset (debt absorbed into monthly balance)', async () => {
    // 0¢ remaining, 300¢ debt, 500¢ free allowance → net = (0 − 300) + 500 = 200¢.
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, debtCents: 300, monthlyPeriodEnd: PAST }]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 200, topupRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { set?: Record<string, unknown> } = {};
    mockResetTransaction(sink, { monthlyRemainingCents: 0, debtCents: 300, monthlyPeriodEnd: PAST });
    mockTransaction({ monthlyRemainingCents: 200, topupRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'free');

    // Debt absorbed: net = 0 − 300 + 500 = 200; debtCents zeroed in the UPDATE.
    expect(sink.set).toMatchObject({ monthlyRemainingCents: 200, monthlyAllowanceCents: 500, debtCents: 0 });
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
    // 1st select: no row. After the init transaction, the auth transaction's locked read
    // sees the persisted row.
    mockDb.select.mockReturnValueOnce(selectReturning([]));
    const initSink: { balanceValues?: Record<string, unknown> } = {};
    mockLazyInitTransaction(initSink);
    mockTransaction({ monthlyRemainingCents: 1500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'pro');

    expect(initSink.balanceValues?.monthlyPeriodStart).toBeInstanceOf(Date);
    expect(initSink.balanceValues?.monthlyPeriodEnd).toBeInstanceOf(Date);
    expect(r.allowed).toBe(true);
    expect(r.holdId).toBe('hold_1');
  });

  it('re-evaluates against the persisted (drained) row after a concurrent init — no false allow', async () => {
    mockDb.select.mockReturnValueOnce(selectReturning([]));
    mockLazyInitTransaction();
    // The locked read inside the auth transaction sees an empty balance (a racing request drained it).
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
    mockResetTransaction(sink, { monthlyRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: PAST });
    mockTransaction({ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'free');

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
    mockResetTransaction(sink, { monthlyRemainingCents: 200, debtCents: 0, monthlyPeriodEnd: PAST });
    mockTransaction({ monthlyRemainingCents: 700, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'free');

    expect(sink.set).toMatchObject({ monthlyRemainingCents: 700, monthlyAllowanceCents: 500 });
    expect(r.allowed).toBe(true);
  });

  it('grants the monthly allowance and stamps a window when a top-up created the row without a period', async () => {
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 2500, monthlyPeriodEnd: null }]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 500, topupRemainingCents: 2500, monthlyPeriodEnd: FUTURE }]));
    const sink: { set?: Record<string, unknown> } = {};
    mockResetTransaction(sink, { monthlyRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: null });
    mockTransaction({ monthlyRemainingCents: 500, topupRemainingCents: 2500, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'free');

    expect(sink.set).toMatchObject({ monthlyRemainingCents: 500, monthlyAllowanceCents: 500 });
    expect(r.allowed).toBe(true);
  });

  it('does NOT gate-reset a paid user with an expired window while a renewal-capable subscription exists — invoice.paid is authoritative', async () => {
    mockDb.select
      // 1st: balance pre-read (expired window)
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]))
      // 2nd: subscription lookup — a live (renewal-capable) subscription row
      .mockReturnValueOnce(selectReturning([{ id: 'sub_1' }]));
    mockTransaction({ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'pro');
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(r).toMatchObject({ allowed: false, reason: 'out_of_credits' });
  });

  it('gate-resets a paid user with an expired window and NO renewal-capable subscription (comped account — no invoice will ever roll it)', async () => {
    mockDb.select
      // 1st: balance pre-read (expired window)
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]))
      // 2nd: subscription lookup — no live subscription rows
      .mockReturnValueOnce(selectReturning([]))
      // 3rd: balance re-read after the reset
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 10000, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { set?: Record<string, unknown>; ledgerValues?: Record<string, unknown> } = {};
    mockResetTransaction(sink, { monthlyRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: PAST });
    mockTransaction({ monthlyRemainingCents: 10000, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'business');

    // Business tier allowance (10000¢) granted, window rolled.
    expect(sink.set).toMatchObject({ monthlyRemainingCents: 10000, monthlyAllowanceCents: 10000 });
    expect(sink.ledgerValues).toMatchObject({ entryType: 'monthly_grant', amountCents: 10000 });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok');
  });

  it('treats an "unpaid" subscription as renewal-capable — its open invoices are still collectible, so no gate roll', async () => {
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]))
      .mockReturnValueOnce(selectReturning([{ id: 'sub_unpaid' }])); // status filter matched an 'unpaid' row
    mockTransaction({ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'pro');
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(r).toMatchObject({ allowed: false, reason: 'out_of_credits' });
  });

  it('does NOT gate-reset a tier with no defined allowance (legacy "normal") — the roll would rewrite the account to free-tier values', async () => {
    mockDb.select.mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]));
    mockTransaction({ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'normal' as unknown as Parameters<typeof canConsumeAI>[1]);
    // Neither the reset transaction nor the subscription lookup ran — one select (pre-read) only.
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ allowed: false, reason: 'out_of_credits' });
  });

  it('aborts the paid gate-reset when a renewal-capable subscription appears between the pre-check and the grant (in-tx re-check)', async () => {
    mockDb.select
      // 1st: balance pre-read (expired window)
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]))
      // 2nd: unlocked subscription lookup — nothing yet (checkout still in flight)
      .mockReturnValueOnce(selectReturning([]))
      // 3rd: balance re-read after the (aborted) reset — unchanged
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]));
    const sink: { updateCalled?: boolean; ledgerValues?: Record<string, unknown> } = {};
    // In-tx re-check now sees the freshly committed subscription row → abort.
    mockResetTransaction(sink, { monthlyRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: PAST }, [{ id: 'sub_new' }]);
    mockTransaction({ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'business');

    expect(sink.updateCalled).toBeUndefined(); // no grant written
    expect(sink.ledgerValues).toBeUndefined();
    expect(r).toMatchObject({ allowed: false, reason: 'out_of_credits' }); // invoice.paid owns the refill now
  });

  it('does NOT look up subscriptions for a free user with an expired window (free reset path unchanged)', async () => {
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    mockResetTransaction({}, { monthlyRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: PAST });
    mockTransaction({ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'free');

    // Exactly two unlocked selects: the pre-read and the post-reset re-read — no
    // subscription lookup in between.
    expect(mockDb.select).toHaveBeenCalledTimes(2);
    expect(r.allowed).toBe(true);
  });

  it('counts a paid user\'s carried monthly balance as spendable even after the window expires (rollover)', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 300, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]));
    mockTransaction({ monthlyRemainingCents: 300, topupRemainingCents: 0, monthlyPeriodEnd: PAST }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'pro');
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok');
  });

  it('still counts a paid user\'s top-up bucket when the monthly window has expired', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 1000, monthlyPeriodEnd: PAST }]));
    mockTransaction({ monthlyRemainingCents: 0, topupRemainingCents: 1000, monthlyPeriodEnd: PAST }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'pro');
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok');
  });

  it('does NOT reset when the period is still active', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 800, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    mockTransaction({ monthlyRemainingCents: 800, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'free');
    expect(r.allowed).toBe(true);
  });

  // ── Ledger write tests ────────────────────────────────────────────────────

  it('lazy-init writes a monthly_grant ledger row alongside the balance row', async () => {
    mockDb.select.mockReturnValueOnce(selectReturning([]));
    const sink: { balanceValues?: Record<string, unknown>; ledgerValues?: Record<string, unknown> } = {};
    mockLazyInitTransaction(sink);
    mockTransaction({ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    await canConsumeAI('u1', 'free');

    expect(sink.ledgerValues).toMatchObject({
      userId: 'u1',
      entryType: 'monthly_grant',
      bucket: 'monthly',
      amountCents: 500,
      consumeStatus: 'applied',
    });
  });

  it('concurrent lazy-init produces exactly ONE grant row — stripeRef is user-scoped (no timestamp)', async () => {
    // The unique index on stripeRef rejects a second insert with the same key.
    // A timestamp-based key would let two concurrent inits produce two different
    // stripeRefs and both insert, causing phantom grants. Verify the key is stable.
    mockDb.select.mockReturnValueOnce(selectReturning([]));
    const sink: { ledgerValues?: Record<string, unknown> } = {};
    mockLazyInitTransaction(sink);
    mockTransaction({ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    await canConsumeAI('u1', 'free');

    // The key contains no timestamp — both concurrent inits produce the same
    // stripeRef, so the unique index silently drops the second via onConflictDoNothing.
    expect(sink.ledgerValues?.stripeRef).toBe('free-init-u1');
  });

  it('lazy-init skips ledger write when balance insert conflicts (concurrent top-up/invoice already created the row)', async () => {
    // If a top-up or invoice.paid creates the balance between readBalance() and the lazy-init
    // transaction, the balance INSERT conflicts and returns nothing. We must NOT write
    // a phantom grant row — that path already wrote its own grant/purchase entry.
    mockDb.select.mockReturnValueOnce(selectReturning([]));
    const sink: { ledgerValues?: Record<string, unknown> } = {};
    mockLazyInitTransaction(sink, false /* balanceCreated = false, simulates conflict */);
    mockTransaction({ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    await canConsumeAI('u1', 'free');

    expect(sink.ledgerValues).toBeUndefined();
  });

  it('free-tier monthly reset writes a monthly_grant ledger row with the period-keyed stripeRef', async () => {
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { set?: Record<string, unknown>; ledgerValues?: Record<string, unknown> } = {};
    mockResetTransaction(sink, { monthlyRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: PAST });
    mockTransaction({ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    await canConsumeAI('u1', 'free');

    expect(sink.ledgerValues).toMatchObject({
      userId: 'u1',
      entryType: 'monthly_grant',
      bucket: 'monthly',
      amountCents: 500,
      consumeStatus: 'applied',
    });
    // The stripeRef includes the period timestamp so each rollover gets a unique
    // key; concurrent resets within the same millisecond de-duplicate via the index.
    expect(typeof sink.ledgerValues?.stripeRef).toBe('string');
    expect((sink.ledgerValues?.stripeRef as string).startsWith('free-reset-u1-')).toBe(true);
  });

  // ── Locked-read ordering (M7 race fix) ──────────────────────────────────────
  // The refill MUST be computed from the balance read FOR UPDATE inside the reset
  // transaction, never from the unlocked pre-transaction snapshot. Otherwise a
  // mutation committed between the two reads is clobbered by the reset.

  it('computes the refill from the post-lock read, NOT the unlocked pre-read snapshot', async () => {
    // Pre-transaction snapshot is stale: it shows 200¢ remaining. A concurrent settle
    // commits before we take the row lock, leaving only 50¢. The locked read inside the
    // txn must drive the refill: 50 + 500 = 550 (NOT the stale 200 + 500 = 700, which
    // would silently un-bill the concurrent spend).
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 200, topupRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: PAST }]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 550, topupRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { set?: Record<string, unknown>; updateCalled?: boolean } = {};
    // Locked row diverges from the pre-read: only 50¢ left.
    mockResetTransaction(sink, { monthlyRemainingCents: 50, debtCents: 0, monthlyPeriodEnd: PAST });
    mockTransaction({ monthlyRemainingCents: 550, topupRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'free');

    // 550, not 700 — proves the refill used the locked read.
    expect(sink.set).toMatchObject({ monthlyRemainingCents: 550, monthlyAllowanceCents: 500, debtCents: 0 });
    expect(r.allowed).toBe(true);
  });

  it('nets debt from the LOCKED row so a concurrent debt-clearing top-up is not collected twice', async () => {
    // Pre-read snapshot shows 300¢ debt. A concurrent top-up pays it off before we lock,
    // so the locked read shows 0 debt. The refill must net against the locked debt (0):
    // 0 + 500 = 500. Using the stale 300¢ debt would re-collect already-paid debt
    // (0 − 300 + 500 = 200), shorting the user 300¢.
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, debtCents: 300, monthlyPeriodEnd: PAST }]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 500, topupRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { set?: Record<string, unknown> } = {};
    mockResetTransaction(sink, { monthlyRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: PAST });
    mockTransaction({ monthlyRemainingCents: 500, topupRemainingCents: 0, debtCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'free');

    expect(sink.set).toMatchObject({ monthlyRemainingCents: 500, debtCents: 0 });
    expect(r.allowed).toBe(true);
  });

  it('skips the UPDATE + grant when the locked read shows the window already rolled forward (concurrent reset won)', async () => {
    // The unlocked pre-read still shows an expired window, so we open the reset txn —
    // but by the time we hold the lock a concurrent reset has rolled the window into the
    // FUTURE. We must NOT update or write a grant; just re-read and proceed.
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { set?: Record<string, unknown>; ledgerValues?: Record<string, unknown>; updateCalled?: boolean } = {};
    // Locked window is FUTURE → predicate recheck fails → skip.
    mockResetTransaction(sink, { monthlyRemainingCents: 500, debtCents: 0, monthlyPeriodEnd: FUTURE });
    mockTransaction({ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'free');

    expect(sink.updateCalled).toBeFalsy();
    expect(sink.set).toBeUndefined();
    expect(sink.ledgerValues).toBeUndefined();
    // The post-reset re-read picks up the concurrently-rolled balance and the gate allows.
    expect(r.allowed).toBe(true);
  });

  it('skips the UPDATE + grant when the locked read finds no row (row removed before the lock)', async () => {
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { set?: Record<string, unknown>; ledgerValues?: Record<string, unknown>; updateCalled?: boolean } = {};
    mockResetTransaction(sink, null); // locked read returns []
    mockTransaction({ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }, { reserved: 0, inFlight: 0 });

    const r = await canConsumeAI('u1', 'free');

    expect(sink.updateCalled).toBeFalsy();
    expect(sink.ledgerValues).toBeUndefined();
    expect(r.allowed).toBe(true);
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
    delete process.env.DAILY_USER_EXPOSURE_CAP_CENTS;
    delete process.env.DAILY_CAP_BUSINESS_CENTS;
  });

  const BAL = { monthlyRemainingCents: 100_000, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE };

  it('denies (429-mapped) when the day spend + this call exceeds the cap, with enforcement ON', async () => {
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
    process.env.DAILY_USER_EXPOSURE_CAP_CENTS = '500';
    const sink: { insertCalled?: boolean } = {};
    mockTransactionWithDailyCharge(BAL, { reserved: 0, inFlight: 0 }, 100_000, sink); // 100¢ + 25 < 500

    const r = await canConsumeAI('u1', 'pro');

    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok');
    expect(sink.insertCalled).toBe(true);
  });

  it('counts active in-flight hold reservations toward the cap (burst cannot exceed it)', async () => {
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
    process.env.DAILY_USER_EXPOSURE_CAP_CENTS = '500';
    mockTransactionWithDailyCharge(BAL, { reserved: 0, inFlight: 0 }, 100_000);

    await canConsumeAI('u1', 'pro');

    const { inArray } = await import('@pagespace/db/operators');
    // The daily-cap query scopes to usage + adjustment rows (chargeMillicents is set on
    // those; NULL elsewhere) so an in-debt user's full charge still counts.
    expect(inArray).toHaveBeenCalledWith('cl.entryType', ['usage', 'adjustment']);
  });

  it('bypasses the cap entirely when skipDailyCap is set (system caller)', async () => {
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
    // DAILY_USER_EXPOSURE_CAP_CENTS unset → cap disabled. Use the 2-select transaction;
    // a 3rd select would throw if the cap path ran.
    const sink: { insertCalled?: boolean } = {};
    mockTransaction(BAL, { reserved: 0, inFlight: 0 }, sink);

    const r = await canConsumeAI('u1', 'pro');

    expect(r.allowed).toBe(true);
    expect(sink.insertCalled).toBe(true);
  });

  it('applies a caller-supplied dailyCapCeilingCents even when no env cap is configured', async () => {
    // The env caps default to 0 = disabled, but a caller whose runs are forced
    // by a bearer credential (webhook triggers) passes an explicit ceiling that
    // must bind regardless: 480¢ today + EST(25) = 505 > 500 → deny.
    const sink: { insertCalled?: boolean } = {};
    mockTransactionWithDailyCharge(BAL, { reserved: 0, inFlight: 0 }, 480_000, sink);

    const r = await canConsumeAI('u1', 'pro', { dailyCapCeilingCents: 500 });

    expect(r).toEqual({ allowed: false, reason: 'daily_cap_exceeded' });
    expect(sink.insertCalled).toBeFalsy();
  });

  it('effective cap is the smaller of the tier cap and the caller ceiling', async () => {
    process.env.DAILY_USER_EXPOSURE_CAP_CENTS = '1000';
    // 480¢ + 25 = 505: under the env cap (1000) but over the ceiling (500) → deny.
    const sink: { insertCalled?: boolean } = {};
    mockTransactionWithDailyCharge(BAL, { reserved: 0, inFlight: 0 }, 480_000, sink);

    const r = await canConsumeAI('u1', 'pro', { dailyCapCeilingCents: 500 });

    expect(r).toEqual({ allowed: false, reason: 'daily_cap_exceeded' });
  });

  it('allows + reserves a hold when the day spend stays under the caller ceiling', async () => {
    const sink: { insertCalled?: boolean } = {};
    mockTransactionWithDailyCharge(BAL, { reserved: 0, inFlight: 0 }, 100_000, sink); // 100¢ + 25 < 500

    const r = await canConsumeAI('u1', 'pro', { dailyCapCeilingCents: 500 });

    expect(r.allowed).toBe(true);
    expect(sink.insertCalled).toBe(true);
  });

  it('ignores a zero ceiling (cap stays disabled when no env cap is set)', async () => {
    // 2-select transaction: a 3rd select would throw if the cap path ran.
    const sink: { insertCalled?: boolean } = {};
    mockTransaction(BAL, { reserved: 0, inFlight: 0 }, sink);

    const r = await canConsumeAI('u1', 'pro', { dailyCapCeilingCents: 0 });

    expect(r.allowed).toBe(true);
    expect(sink.insertCalled).toBe(true);
  });
});
