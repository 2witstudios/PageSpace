import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const mockIsBillingEnabled = vi.hoisted(() => vi.fn(() => true));
const mockDb = vi.hoisted(() => ({
  insert: vi.fn(),
  transaction: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
const mockAiLogger = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn() }));
const mockEmitCreditsUpdated = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/schema/credits', () => ({
  creditBalances: { userId: 'cb.userId', monthlyRemainingCents: 'cb.monthly', topupRemainingCents: 'cb.topup', pendingMillicents: 'cb.pending', debtCents: 'cb.debt' },
  creditLedger: { id: 'cl.id', aiUsageLogId: 'cl.aiUsageLogId', entryType: 'cl.entryType' },
  creditHolds: { id: 'ch.id' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: true, strings, values })),
}));
vi.mock('../../deployment-mode', () => ({ isBillingEnabled: mockIsBillingEnabled }));
vi.mock('../../logging/logger-config', () => ({ loggers: { ai: mockAiLogger } }));
// The live `credits:updated` broadcast is exercised by its own suite; here we only
// assert that the billing primitives FIRE it at each balance/hold mutation.
vi.mock('../credit-emit', () => ({ emitCreditsUpdated: mockEmitCreditsUpdated }));

import { consumeCredits, settlePendingLedgerRow, releaseHold } from '../credit-consume';

// Build a claim-insert chain that resolves to `returned`.
function claimReturning(returned: Array<{ id: string }>) {
  return {
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returned),
      }),
    }),
  };
}

describe('consumeCredits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBillingEnabled.mockReturnValue(true);
  });

  it('does nothing when billing is disabled (tenant/onprem)', async () => {
    mockIsBillingEnabled.mockReturnValue(false);
    await consumeCredits({ aiUsageLogId: 'aul_1', userId: 'u1', costDollars: 1 });
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('spends monthly first, then top-up, and settles the ledger row', async () => {
    mockDb.insert.mockReturnValue(claimReturning([{ id: 'led_1' }]));
    // cost $1.00 -> ×1.5 -> 150 cents. monthly 100, topup 1000 -> monthly 0, topup 950.
    const captured: { balanceSet?: Record<string, number>; ledgerSet?: Record<string, unknown> } = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const balanceUpdateWhere = vi.fn().mockResolvedValue(undefined);
      const ledgerUpdateWhere = vi.fn().mockResolvedValue(undefined);
      const tx = {
        select: () => ({ from: () => ({ where: () => ({ for: () => Promise.resolve([{ monthlyRemainingCents: 100, topupRemainingCents: 1000 }]) }) }) }),
        update: vi.fn()
          .mockReturnValueOnce({ set: (v: Record<string, number>) => { captured.balanceSet = v; return { where: balanceUpdateWhere }; } })
          .mockReturnValueOnce({ set: (v: Record<string, unknown>) => { captured.ledgerSet = v; return { where: ledgerUpdateWhere }; } }),
      };
      await cb(tx);
    });

    await consumeCredits({ aiUsageLogId: 'aul_1', userId: 'u1', costDollars: 1 });

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(captured.balanceSet).toEqual({ monthlyRemainingCents: 0, topupRemainingCents: 950, pendingMillicents: 0 });
    // appliedCents records what truly left the balance (signed -): 100 monthly + 50 topup.
    expect(captured.ledgerSet).toMatchObject({ consumeStatus: 'applied', appliedCents: -150 });
    // The debit committed -> push the user's fresh balance for the live navbar.
    expect(mockEmitCreditsUpdated).toHaveBeenCalledWith('u1', expect.anything());
  });

  it('floors the buckets at 0, raises debtCents by the shortfall, and records a debt adjustment row', async () => {
    // cost $1.00 -> 150 cents charge. Balance only has 30 monthly + 20 topup = 50.
    // Expect: buckets floored to 0/0, debtCents raised by the uncovered 100 cents (so the
    // net balance goes negative), appliedCents = -50 (what left), AND a -100 'adjustment'
    // ledger row linking the same aiUsageLogId (the incurrence history).
    mockDb.insert.mockReturnValue(claimReturning([{ id: 'led_short' }]));
    const captured: { balanceSet?: Record<string, unknown>; ledgerSet?: Record<string, unknown>; debtRow?: Record<string, unknown> } = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        select: () => ({ from: () => ({ where: () => ({ for: () => Promise.resolve([{ monthlyRemainingCents: 30, topupRemainingCents: 20, pendingMillicents: 0, debtCents: 0 }]) }) }) }),
        update: vi.fn()
          .mockReturnValueOnce({ set: (v: Record<string, unknown>) => { captured.balanceSet = v; return { where: vi.fn().mockResolvedValue(undefined) }; } })
          .mockReturnValueOnce({ set: (v: Record<string, unknown>) => { captured.ledgerSet = v; return { where: vi.fn().mockResolvedValue(undefined) }; } }),
        insert: vi.fn().mockReturnValue({ values: (v: Record<string, unknown>) => { captured.debtRow = v; return Promise.resolve(undefined); } }),
      };
      await cb(tx);
    });

    await consumeCredits({ aiUsageLogId: 'aul_short', userId: 'u1', costDollars: 1 });

    expect(captured.balanceSet).toMatchObject({ monthlyRemainingCents: 0, topupRemainingCents: 0, pendingMillicents: 0 });
    // debtCents is bumped by the uncovered 100 via a `debtCents + 100` SQL expression.
    expect(captured.balanceSet!.debtCents).toMatchObject({ sql: true, values: ['cb.debt', 100] });
    expect(captured.ledgerSet).toMatchObject({ consumeStatus: 'applied', appliedCents: -50 });
    // Debt row: the uncovered 100 cents, owed, terminal status (not retried), same aiUsageLogId.
    expect(captured.debtRow).toMatchObject({
      entryType: 'adjustment',
      bucket: 'monthly',
      amountCents: -100,
      aiUsageLogId: 'aul_short',
      consumeStatus: 'applied',
    });
  });

  it('draws from the carry monthly balance even after the period has expired (rollover)', async () => {
    // Rollover: carry credits are always spendable — period expiry is irrelevant at settle.
    // cost $1 -> 150¢. Monthly 300 (expired period), topup 1000 -> draws monthly-first.
    mockDb.insert.mockReturnValue(claimReturning([{ id: 'led_exp' }]));
    const captured: { balanceSet?: Record<string, number>; ledgerSet?: Record<string, unknown> } = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        select: () => ({ from: () => ({ where: () => ({ for: () => Promise.resolve([{
          monthlyRemainingCents: 300,
          topupRemainingCents: 1000,
          pendingMillicents: 0,
          monthlyPeriodEnd: new Date(Date.now() - 60 * 60 * 1000), // expired 1h ago
        }]) }) }) }),
        update: vi.fn()
          .mockReturnValueOnce({ set: (v: Record<string, number>) => { captured.balanceSet = v; return { where: vi.fn().mockResolvedValue(undefined) }; } })
          .mockReturnValueOnce({ set: (v: Record<string, unknown>) => { captured.ledgerSet = v; return { where: vi.fn().mockResolvedValue(undefined) }; } }),
        insert: vi.fn().mockReturnValue({ values: () => Promise.resolve(undefined) }),
      };
      await cb(tx);
    });

    await consumeCredits({ aiUsageLogId: 'aul_exp', userId: 'u1', costDollars: 1 });

    // Rollover: monthly drawn first (300 → 150), top-up untouched.
    expect(captured.balanceSet).toEqual({ monthlyRemainingCents: 150, topupRemainingCents: 1000, pendingMillicents: 0 });
    expect(captured.ledgerSet).toMatchObject({ consumeStatus: 'applied', appliedCents: -150, bucket: 'monthly' });
  });

  it('does not insert a debt row when the balance fully covers the charge', async () => {
    mockDb.insert.mockReturnValue(claimReturning([{ id: 'led_ok' }]));
    let insertCalled = false;
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        select: () => ({ from: () => ({ where: () => ({ for: () => Promise.resolve([{ monthlyRemainingCents: 1000, topupRemainingCents: 0, pendingMillicents: 0 }]) }) }) }),
        update: vi.fn()
          .mockReturnValueOnce({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) })
          .mockReturnValueOnce({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
        insert: vi.fn(() => { insertCalled = true; return { values: () => Promise.resolve(undefined) }; }),
      };
      await cb(tx);
    });

    await consumeCredits({ aiUsageLogId: 'aul_ok', userId: 'u1', costDollars: 1 });
    expect(insertCalled).toBe(false);
  });

  it('carries a sub-cent charge into pendingMillicents without decrementing whole cents', async () => {
    // cost $0.0033 -> 495 millicents charge (chargeMillicents), < 1 whole cent.
    // The call is NOT skipped: it opens the txn and banks the fraction in pending,
    // leaving the balance untouched. A later call crosses the whole-cent boundary.
    mockDb.insert.mockReturnValue(claimReturning([{ id: 'led_sub' }]));
    const captured: { balanceSet?: Record<string, number>; ledgerSet?: Record<string, unknown> } = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        // 600 already carried + 495 = 1095 -> 1 whole cent crosses, 95 carried.
        select: () => ({ from: () => ({ where: () => ({ for: () => Promise.resolve([{ monthlyRemainingCents: 500, topupRemainingCents: 0, pendingMillicents: 600 }]) }) }) }),
        update: vi.fn()
          .mockReturnValueOnce({ set: (v: Record<string, number>) => { captured.balanceSet = v; return { where: vi.fn().mockResolvedValue(undefined) }; } })
          .mockReturnValueOnce({ set: (v: Record<string, unknown>) => { captured.ledgerSet = v; return { where: vi.fn().mockResolvedValue(undefined) }; } }),
        insert: vi.fn().mockReturnValue({ values: () => Promise.resolve(undefined) }),
      };
      await cb(tx);
    });

    await consumeCredits({ aiUsageLogId: 'aul_sub', userId: 'u1', costDollars: 0.0033 });

    // Not skipped — the transaction ran and the fraction was banked.
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(captured.balanceSet).toEqual({ monthlyRemainingCents: 499, topupRemainingCents: 0, pendingMillicents: 95 });
    expect(captured.ledgerSet).toMatchObject({ consumeStatus: 'applied', appliedCents: -1 });
  });

  it('declares the partial-index predicate on the idempotent claim so Postgres can infer the arbiter', async () => {
    // The unique index on aiUsageLogId is PARTIAL (WHERE aiUsageLogId IS NOT NULL);
    // ON CONFLICT must supply that predicate or Postgres raises 42P10 on every insert.
    const onConflict = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'led_1' }]) });
    mockDb.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing: onConflict }) });
    mockDb.transaction.mockResolvedValue(undefined);

    await consumeCredits({ aiUsageLogId: 'aul_1', userId: 'u1', costDollars: 1 });

    expect(onConflict).toHaveBeenCalledTimes(1);
    const arg = onConflict.mock.calls[0][0] as { target?: unknown; where?: unknown };
    expect(arg).toHaveProperty('target');
    expect(arg.where).toBeDefined();
  });

  it('claims the usage row with the precise sub-cent charge (chargeMillicents) for accurate replay', async () => {
    let claimValues: Record<string, unknown> | undefined;
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        claimValues = v;
        return { onConflictDoNothing: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'led_1' }]) }) };
      }),
    });
    mockDb.transaction.mockResolvedValue(undefined);

    await consumeCredits({ aiUsageLogId: 'aul_1', userId: 'u1', costDollars: 0.0033 });

    // $0.0033 ×1.5 = 0.495 cents = 495 millicents; nominal whole-cent amount rounds to 0.
    expect(claimValues).toMatchObject({ entryType: 'usage', chargeMillicents: 495, amountCents: 0 });
  });

  it('honors markupBpsOverride instead of the global MARKUP_BPS when a caller supplies one', async () => {
    // Proves the terminal-floor override actually changes what gets charged — a caller
    // (machine-billing.ts) that passes markupBpsOverride is NOT at the mercy of whatever
    // MARKUP_BPS happens to default to. $1.00 at 20000bps (2x) -> 200 cents = 200000 millicents,
    // not the 150000 millicents a MARKUP_BPS-only (1.5x) call would produce.
    let claimValues: Record<string, unknown> | undefined;
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        claimValues = v;
        return { onConflictDoNothing: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'led_override' }]) }) };
      }),
    });
    mockDb.transaction.mockResolvedValue(undefined);

    await consumeCredits({ aiUsageLogId: 'aul_override', userId: 'u1', costDollars: 1, markupBpsOverride: 20000 });

    expect(claimValues).toMatchObject({ chargeMillicents: 200000, markupBps: 20000 });
  });

  it('leaves the ledger row pending (never marks applied) when no balance row exists yet', async () => {
    // Existing users have no credit_balances row until the gate lazy-inits one.
    // Marking the ledger 'applied' without a balance to decrement would silently
    // drop the charge AND hide it from the reconcile cron. It must stay pending.
    mockDb.insert.mockReturnValue(claimReturning([{ id: 'led_1' }]));
    const update = vi.fn();
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        select: () => ({ from: () => ({ where: () => ({ for: () => Promise.resolve([]) }) }) }), // no balance row
        update,
      };
      await cb(tx);
    });

    await consumeCredits({ aiUsageLogId: 'aul_1', userId: 'u1', costDollars: 1 });

    // Neither the balance nor the ledger is updated -> the row stays 'pending'.
    expect(update).not.toHaveBeenCalled();
  });

  it('settles a zero-charge call (free model / tool-only log) as skipped, without opening the balance transaction', async () => {
    // cost 0 -> markupCents 0 -> nothing to draw down. The claim row is still
    // written (idempotency/orphan-sweep marker) but we must NOT take the balance
    // row lock or run a $0 decrement for it.
    mockDb.insert.mockReturnValue(claimReturning([{ id: 'led_zero' }]));
    let ledgerSet: Record<string, unknown> | undefined;
    const where = vi.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({ set: (v: Record<string, unknown>) => { ledgerSet = v; return { where }; } });

    await consumeCredits({ aiUsageLogId: 'aul_free', userId: 'u1', costDollars: 0 });

    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(ledgerSet).toEqual({ consumeStatus: 'skipped' });
  });

  it('skips an invalid cost (negative or non-finite) without claiming a ledger row', async () => {
    await consumeCredits({ aiUsageLogId: 'aul_neg', userId: 'u1', costDollars: -5 });
    await consumeCredits({ aiUsageLogId: 'aul_nan', userId: 'u1', costDollars: Number.NaN });
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('is idempotent: a duplicate aiUsageLogId (conflict) skips the decrement', async () => {
    mockDb.insert.mockReturnValue(claimReturning([])); // conflict -> no row returned
    await consumeCredits({ aiUsageLogId: 'aul_dup', userId: 'u1', costDollars: 1 });
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('does not throw and leaves the row pending when the decrement transaction fails', async () => {
    mockDb.insert.mockReturnValue(claimReturning([{ id: 'led_1' }]));
    mockDb.transaction.mockRejectedValueOnce(new Error('tx boom'));
    await expect(
      consumeCredits({ aiUsageLogId: 'aul_1', userId: 'u1', costDollars: 1 }),
    ).resolves.toBeUndefined();
    expect(mockAiLogger.debug).toHaveBeenCalled();
  });

  it('releases the gate hold inside the settle transaction when a holdId is threaded through', async () => {
    mockDb.insert.mockReturnValue(claimReturning([{ id: 'led_1' }]));
    let holdDeleted = false;
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        select: () => ({ from: () => ({ where: () => ({ for: () => Promise.resolve([{ monthlyRemainingCents: 1000, topupRemainingCents: 0, pendingMillicents: 0 }]) }) }) }),
        update: vi.fn()
          .mockReturnValueOnce({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) })
          .mockReturnValueOnce({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
        insert: vi.fn().mockReturnValue({ values: () => Promise.resolve(undefined) }),
        delete: vi.fn(() => ({ where: () => { holdDeleted = true; return Promise.resolve(undefined); } })),
      };
      await cb(tx);
    });

    await consumeCredits({ aiUsageLogId: 'aul_1', userId: 'u1', costDollars: 1, holdId: 'hold_42' });

    // The hold release happens in the SAME transaction as the balance decrement.
    expect(holdDeleted).toBe(true);
  });

  it('does NOT touch holds when no holdId is provided (backfill/orphan path)', async () => {
    mockDb.insert.mockReturnValue(claimReturning([{ id: 'led_1' }]));
    const txDelete = vi.fn();
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        select: () => ({ from: () => ({ where: () => ({ for: () => Promise.resolve([{ monthlyRemainingCents: 1000, topupRemainingCents: 0, pendingMillicents: 0 }]) }) }) }),
        update: vi.fn()
          .mockReturnValueOnce({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) })
          .mockReturnValueOnce({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
        insert: vi.fn().mockReturnValue({ values: () => Promise.resolve(undefined) }),
        delete: txDelete,
      };
      await cb(tx);
    });

    await consumeCredits({ aiUsageLogId: 'aul_1', userId: 'u1', costDollars: 1 });
    expect(txDelete).not.toHaveBeenCalled();
  });

  it('releases the hold on a zero-charge call without opening the balance transaction', async () => {
    mockDb.insert.mockReturnValue(claimReturning([{ id: 'led_zero' }]));
    mockDb.update.mockReturnValue({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) });
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: deleteWhere });

    await consumeCredits({ aiUsageLogId: 'aul_free', userId: 'u1', costDollars: 0, holdId: 'hold_free' });

    expect(mockDb.transaction).not.toHaveBeenCalled();
    // Ledger settled 'skipped' AND the hold released, both outside a transaction.
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    // Releasing the hold frees spendable -> push the user's fresh balance.
    expect(mockEmitCreditsUpdated).toHaveBeenCalledWith('u1', expect.anything());
  });
});

describe('releaseHold', () => {
  // delete().where().returning({ userId }) — returning() yields the freed hold's owner.
  function deleteReturning(rows: Array<{ userId: string }>) {
    const returning = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ returning });
    mockDb.delete.mockReturnValue({ where });
    return { where, returning };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBillingEnabled.mockReturnValue(true);
  });

  it('deletes the hold row by id and pushes the freed balance to its owner', async () => {
    const { where } = deleteReturning([{ userId: 'u1' }]);
    await releaseHold('hold_99');
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
    expect(mockEmitCreditsUpdated).toHaveBeenCalledWith('u1');
  });

  it('does not emit when no hold row was deleted (already swept/expired)', async () => {
    deleteReturning([]);
    await releaseHold('hold_gone');
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(mockEmitCreditsUpdated).not.toHaveBeenCalled();
  });

  it('still deletes the hold when billing is disabled (billing-off ceiling reservations must not linger), but skips the credits push', async () => {
    mockIsBillingEnabled.mockReturnValue(false);
    const { where } = deleteReturning([{ userId: 'u1' }]);
    await releaseHold('hold_99');
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
    expect(mockEmitCreditsUpdated).not.toHaveBeenCalled();
  });

  it('never throws if the delete fails', async () => {
    mockDb.delete.mockImplementation(() => { throw new Error('boom'); });
    await expect(releaseHold('hold_99')).resolves.toBeUndefined();
    expect(mockAiLogger.debug).toHaveBeenCalled();
  });
});

describe('settlePendingLedgerRow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('re-applies a pending row using its stored amount (monthly-first)', async () => {
    const captured: { balanceSet?: Record<string, number>; ledgerSet?: Record<string, unknown> } = {};
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      let selectCall = 0;
      const tx = {
        select: () => ({ from: () => ({ where: () => ({ for: () => {
          selectCall++;
          return Promise.resolve(
            selectCall === 1
              // Legacy pending row (no chargeMillicents): falls back to |amountCents|*1000.
              ? [{ userId: 'u1', amountCents: -150, chargeMillicents: null, aiUsageLogId: 'aul_1', consumeStatus: 'pending' }]
              : [{ monthlyRemainingCents: 200, topupRemainingCents: 0, pendingMillicents: 0 }],
          );
        } }) }) }),
        update: vi.fn()
          .mockReturnValueOnce({ set: (v: Record<string, number>) => { captured.balanceSet = v; return { where: vi.fn().mockResolvedValue(undefined) }; } })
          .mockReturnValueOnce({ set: (v: Record<string, unknown>) => { captured.ledgerSet = v; return { where: vi.fn().mockResolvedValue(undefined) }; } }),
        insert: vi.fn().mockReturnValue({ values: () => Promise.resolve(undefined) }),
      };
      await cb(tx);
    });

    await settlePendingLedgerRow('led_1');
    expect(captured.balanceSet).toEqual({ monthlyRemainingCents: 50, topupRemainingCents: 0, pendingMillicents: 0 });
    expect(captured.ledgerSet).toMatchObject({ consumeStatus: 'applied', appliedCents: -150 });
    // A cron retry that settles still pushes the user's fresh balance.
    expect(mockEmitCreditsUpdated).toHaveBeenCalledWith('u1');
  });

  it('is a no-op when the row is already applied', async () => {
    const update = vi.fn();
    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        select: () => ({ from: () => ({ where: () => ({ for: () =>
          Promise.resolve([{ userId: 'u1', amountCents: -150, consumeStatus: 'applied' }]) }) }) }),
        update,
      };
      await cb(tx);
    });
    await settlePendingLedgerRow('led_1');
    expect(update).not.toHaveBeenCalled();
    // Nothing settled -> nothing to push.
    expect(mockEmitCreditsUpdated).not.toHaveBeenCalled();
  });
});
