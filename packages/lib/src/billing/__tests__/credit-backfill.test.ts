import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const mockIsBillingEnabled = vi.hoisted(() => vi.fn(() => true));
const mockConsumeCredits = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSettlePending = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDb = vi.hoisted(() => ({ select: vi.fn(), transaction: vi.fn() }));
const mockAiLogger = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn() }));

vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/schema/credits', () => ({
  creditBalances: { userId: 'cb.userId' },
  creditLedger: { id: 'cl.id', aiUsageLogId: 'cl.aiUsageLogId', consumeStatus: 'cl.consumeStatus', createdAt: 'cl.createdAt' },
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  aiUsageLogs: { id: 'aul.id', userId: 'aul.userId', cost: 'aul.cost', success: 'aul.success', timestamp: 'aul.timestamp' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...a) => ({ op: 'and', a })),
  lt: vi.fn((a, b) => ({ op: 'lt', a, b })),
  isNull: vi.fn((a) => ({ op: 'isNull', a })),
  isNotNull: vi.fn((a) => ({ op: 'isNotNull', a })),
}));
vi.mock('../../deployment-mode', () => ({ isBillingEnabled: mockIsBillingEnabled }));
vi.mock('../../logging/logger-config', () => ({ loggers: { ai: mockAiLogger } }));
vi.mock('../credit-consume', () => ({
  consumeCredits: mockConsumeCredits,
  settlePendingLedgerRow: mockSettlePending,
}));

import { backfillCredits } from '../credit-backfill';

/**
 * db.select() is called twice: first for pending ledger rows, then for orphan
 * usage rows. Each returns a chain ending in a resolved array.
 */
function mockSelects(pendingRows: unknown[], orphanRows: unknown[]) {
  mockDb.select
    .mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(pendingRows) }) }),
    })
    .mockReturnValueOnce({
      from: () => ({ leftJoin: () => ({ where: () => ({ limit: () => Promise.resolve(orphanRows) }) }) }),
    });
}

describe('backfillCredits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBillingEnabled.mockReturnValue(true);
  });

  it('settles each pending ledger row and consumes each orphan usage row exactly once', async () => {
    mockSelects(
      [{ id: 'led_1' }, { id: 'led_2' }],
      [{ aiUsageLogId: 'aul_9', userId: 'u9', cost: 0.5 }],
    );

    const result = await backfillCredits();

    expect(mockSettlePending).toHaveBeenCalledTimes(2);
    expect(mockSettlePending).toHaveBeenCalledWith('led_1');
    expect(mockSettlePending).toHaveBeenCalledWith('led_2');
    expect(mockConsumeCredits).toHaveBeenCalledTimes(1);
    expect(mockConsumeCredits).toHaveBeenCalledWith({ aiUsageLogId: 'aul_9', userId: 'u9', costDollars: 0.5 });
    expect(result).toEqual({ retried: 2, orphans: 1 });
  });

  it('does nothing when billing is disabled', async () => {
    mockIsBillingEnabled.mockReturnValue(false);
    const result = await backfillCredits();
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(result).toEqual({ retried: 0, orphans: 0 });
  });

  it('is a no-op when nothing is unsettled', async () => {
    mockSelects([], []);
    const result = await backfillCredits();
    expect(mockSettlePending).not.toHaveBeenCalled();
    expect(mockConsumeCredits).not.toHaveBeenCalled();
    expect(result).toEqual({ retried: 0, orphans: 0 });
  });

  it('makes no Stripe calls (reconciliation is local-only)', () => {
    const src = readFileSync(fileURLToPath(new URL('../credit-backfill.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/from ['"]stripe['"]/);
    expect(src).not.toMatch(/stripe\./i);
  });
});
