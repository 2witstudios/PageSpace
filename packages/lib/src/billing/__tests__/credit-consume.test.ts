import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const mockIsBillingEnabled = vi.hoisted(() => vi.fn(() => true));
const mockDb = vi.hoisted(() => ({
  insert: vi.fn(),
  transaction: vi.fn(),
}));
const mockAiLogger = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn() }));

vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/schema/credits', () => ({
  creditBalances: { userId: 'cb.userId', monthlyRemainingCents: 'cb.monthly', topupRemainingCents: 'cb.topup' },
  creditLedger: { id: 'cl.id', aiUsageLogId: 'cl.aiUsageLogId' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: true, strings, values })),
}));
vi.mock('../../deployment-mode', () => ({ isBillingEnabled: mockIsBillingEnabled }));
vi.mock('../../logging/logger-config', () => ({ loggers: { ai: mockAiLogger } }));

import { consumeCredits, settlePendingLedgerRow } from '../credit-consume';

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
    expect(captured.balanceSet).toEqual({ monthlyRemainingCents: 0, topupRemainingCents: 950 });
    expect(captured.ledgerSet).toMatchObject({ consumeStatus: 'applied' });
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
              ? [{ userId: 'u1', amountCents: -150, consumeStatus: 'pending' }] // ledger row
              : [{ monthlyRemainingCents: 200, topupRemainingCents: 0 }],        // balance row
          );
        } }) }) }),
        update: vi.fn()
          .mockReturnValueOnce({ set: (v: Record<string, number>) => { captured.balanceSet = v; return { where: vi.fn().mockResolvedValue(undefined) }; } })
          .mockReturnValueOnce({ set: (v: Record<string, unknown>) => { captured.ledgerSet = v; return { where: vi.fn().mockResolvedValue(undefined) }; } }),
      };
      await cb(tx);
    });

    await settlePendingLedgerRow('led_1');
    expect(captured.balanceSet).toEqual({ monthlyRemainingCents: 50, topupRemainingCents: 0 });
    expect(captured.ledgerSet).toMatchObject({ consumeStatus: 'applied' });
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
  });
});
