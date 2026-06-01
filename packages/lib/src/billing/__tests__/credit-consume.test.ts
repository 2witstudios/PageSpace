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
}));
vi.mock('../../deployment-mode', () => ({ isBillingEnabled: mockIsBillingEnabled }));
vi.mock('../../logging/logger-config', () => ({ loggers: { ai: mockAiLogger } }));

import { consumeCredits } from '../credit-consume';

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
