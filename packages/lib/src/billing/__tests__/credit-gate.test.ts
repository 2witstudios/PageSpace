import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsBillingEnabled = vi.hoisted(() => vi.fn(() => true));
const mockDb = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), update: vi.fn() }));

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
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...a) => ({ op: 'and', a })),
  lt: vi.fn((a, b) => ({ op: 'lt', a, b })),
  or: vi.fn((...a) => ({ op: 'or', a })),
  isNull: vi.fn((a) => ({ op: 'isNull', a })),
}));
vi.mock('../../deployment-mode', () => ({ isBillingEnabled: mockIsBillingEnabled }));

import { canConsumeAI, addOneMonth } from '../credit-gate';

describe('addOneMonth', () => {
  const at = (iso: string) => new Date(iso);

  it('advances a mid-month date by one calendar month, preserving time-of-day', () => {
    expect(addOneMonth(at('2026-01-15T08:30:00.000Z')).toISOString()).toBe('2026-02-15T08:30:00.000Z');
  });

  it('clamps a month-end start to the last valid day instead of overflowing', () => {
    // Jan 31 -> Feb 28 (non-leap), NOT Mar 3.
    expect(addOneMonth(at('2026-01-31T00:00:00.000Z')).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    // Mar 31 -> Apr 30.
    expect(addOneMonth(at('2026-03-31T12:00:00.000Z')).toISOString()).toBe('2026-04-30T12:00:00.000Z');
  });

  it('clamps to Feb 29 in a leap year', () => {
    expect(addOneMonth(at('2028-01-31T00:00:00.000Z')).toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('rolls over the year for a December start', () => {
    expect(addOneMonth(at('2026-12-31T00:00:00.000Z')).toISOString()).toBe('2027-01-31T00:00:00.000Z');
  });
});

function selectReturning(rows: unknown[]) {
  return { from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) };
}
function insertChain() {
  return { values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }) };
}
// Captures the .set() payload of an update chain whose .where() resolves.
function updateCapturing(sink: { set?: Record<string, unknown> }) {
  return { set: (v: Record<string, unknown>) => { sink.set = v; return { where: () => Promise.resolve(undefined) }; } };
}
const PAST = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
const FUTURE = new Date(Date.now() + 60 * 60 * 1000); // 1h ahead

describe('canConsumeAI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBillingEnabled.mockReturnValue(true);
  });

  it('allows unconditionally when billing is disabled (tenant/onprem)', async () => {
    mockIsBillingEnabled.mockReturnValue(false);
    const r = await canConsumeAI('u1', 'free');
    expect(r).toEqual({ allowed: true, reason: 'unlimited' });
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('allows when the user has spendable credits', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 100, topupRemainingCents: 0 }]));
    const r = await canConsumeAI('u1', 'pro');
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok');
  });

  it('denies with out_of_credits when both buckets are empty', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0 }]));
    const r = await canConsumeAI('u1', 'pro');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('out_of_credits');
  });

  it('lazy-inits a balance row from tier defaults (with a period boundary) on first request, then allows', async () => {
    // 1st select: no row -> needs_init. 2nd select (post-insert): the persisted row.
    mockDb.select
      .mockReturnValueOnce(selectReturning([]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 1500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    let initValues: Record<string, unknown> | undefined;
    mockDb.insert.mockReturnValue({
      values: (v: Record<string, unknown>) => { initValues = v; return { onConflictDoNothing: () => Promise.resolve(undefined) }; },
    });
    const r = await canConsumeAI('u1', 'pro');
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    // A free/no-subscription user needs a window for the gate to later roll over.
    expect(initValues?.monthlyPeriodStart).toBeInstanceOf(Date);
    expect(initValues?.monthlyPeriodEnd).toBeInstanceOf(Date);
    expect((initValues?.monthlyPeriodEnd as Date).getTime()).toBeGreaterThan((initValues?.monthlyPeriodStart as Date).getTime());
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('ok');
  });

  it('resets the monthly bucket to the tier allowance when the period has expired (gate-driven, no cron)', async () => {
    // 1st read: expired window with a drained monthly bucket. After reset, 2nd read
    // sees the refreshed allowance. This is how free users get a monthly reset.
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 500, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    const sink: { set?: Record<string, unknown> } = {};
    mockDb.update.mockReturnValue(updateCapturing(sink));

    const r = await canConsumeAI('u1', 'free');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(sink.set).toMatchObject({ monthlyRemainingCents: 500, monthlyAllowanceCents: 500 });
    expect(sink.set?.monthlyPeriodStart).toBeInstanceOf(Date);
    expect((sink.set?.monthlyPeriodEnd as Date).getTime()).toBeGreaterThan(Date.now());
    expect(r).toEqual({ allowed: true, reason: 'ok' });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('grants the monthly allowance and stamps a window when a top-up created the row without a period (period IS NULL)', async () => {
    // A credit-pack purchase created a bare balance row (monthly 0, topup 2500, NULL
    // period) before the free user's first AI request. The gate must grant the free
    // monthly allowance and stamp a window — otherwise the monthly bucket would stay 0
    // and never reset (the reset key is the period boundary).
    mockDb.select
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 2500, monthlyPeriodEnd: null }]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 500, topupRemainingCents: 2500, monthlyPeriodEnd: FUTURE }]));
    const sink: { set?: Record<string, unknown> } = {};
    mockDb.update.mockReturnValue(updateCapturing(sink));

    const r = await canConsumeAI('u1', 'free');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(sink.set).toMatchObject({ monthlyRemainingCents: 500, monthlyAllowanceCents: 500 });
    expect(sink.set?.monthlyPeriodStart).toBeInstanceOf(Date);
    expect((sink.set?.monthlyPeriodEnd as Date).getTime()).toBeGreaterThan(Date.now());
    expect(r).toEqual({ allowed: true, reason: 'ok' });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('does NOT gate-reset a paid (subscription) user with an expired window — invoice.paid is authoritative', async () => {
    // A pro user whose window expired before their renewal invoice landed must NOT be
    // refilled by the gate (that would over-grant when the late/retried invoice.paid
    // eventually refills too). They are blocked until the webhook credits them.
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0, monthlyPeriodEnd: PAST }]));
    const r = await canConsumeAI('u1', 'pro');
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(r).toEqual({ allowed: false, reason: 'out_of_credits' });
  });

  it('does NOT reset when the period is still active', async () => {
    mockDb.select.mockReturnValue(selectReturning([{ monthlyRemainingCents: 800, topupRemainingCents: 0, monthlyPeriodEnd: FUTURE }]));
    const r = await canConsumeAI('u1', 'free');
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(r.allowed).toBe(true);
  });

  it('re-evaluates against the persisted row after a concurrent init (no false allow)', async () => {
    // 1st select: no row -> needs_init. Our insert hits onConflictDoNothing because a
    // concurrent request already created AND drew down the row to empty. We must judge
    // the persisted balance, not the assumed full allowance -> deny.
    mockDb.select
      .mockReturnValueOnce(selectReturning([]))
      .mockReturnValueOnce(selectReturning([{ monthlyRemainingCents: 0, topupRemainingCents: 0 }]));
    mockDb.insert.mockReturnValue(insertChain());
    const r = await canConsumeAI('u1', 'pro');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('out_of_credits');
  });
});
