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
const mockEq = vi.hoisted(() => vi.fn((a, b) => ({ op: 'eq', a, b })));
const mockGt = vi.hoisted(() => vi.fn((a, b) => ({ op: 'gt', a, b })));
vi.mock('@pagespace/db/operators', () => ({
  eq: mockEq,
  and: vi.fn((...a) => ({ op: 'and', a })),
  lt: vi.fn((a, b) => ({ op: 'lt', a, b })),
  gt: mockGt,
  isNull: vi.fn((a) => ({ op: 'isNull', a })),
}));
vi.mock('../../deployment-mode', () => ({ isBillingEnabled: mockIsBillingEnabled }));
vi.mock('../../logging/logger-config', () => ({ loggers: { ai: mockAiLogger } }));
vi.mock('../credit-consume', () => ({
  consumeCredits: mockConsumeCredits,
  settlePendingLedgerRow: mockSettlePending,
}));

import { backfillCredits } from '../credit-backfill';

// Captures the WHERE clause handed to the orphan sweep so tests can assert the
// query shape (e.g. that success:false rows are no longer excluded).
let lastOrphanWhere: unknown;

/**
 * Queue one drain pass: db.select() is called twice per pass — first for pending
 * ledger rows, then for orphan usage rows. Each returns a chain ending in a
 * resolved array. Call once per expected pass; passes are consumed in order.
 */
function queuePass(pendingRows: unknown[], orphanRows: unknown[]) {
  mockDb.select
    .mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(pendingRows) }) }),
    })
    .mockReturnValueOnce({
      from: () => ({
        leftJoin: () => ({
          where: (w: unknown) => {
            lastOrphanWhere = w;
            return { limit: () => Promise.resolve(orphanRows) };
          },
        }),
      }),
    });
}

// Single-pass convenience: rows shorter than BATCH drain in one pass.
function mockSelects(pendingRows: unknown[], orphanRows: unknown[]) {
  queuePass(pendingRows, orphanRows);
}

const BATCH = 200;
const fill = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i));

describe('backfillCredits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks wipes call history but NOT the mockReturnValueOnce queue, so
    // drain any passes a prior test queued but did not consume (e.g. the cap test).
    mockDb.select.mockReset();
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

  it('drains a >BATCH backlog across multiple passes (does not stop at one batch)', async () => {
    // Pass 0 returns a full BATCH of pending rows -> more may remain, loop again.
    // Pass 1 returns fewer than BATCH -> drained, stop.
    queuePass(fill(BATCH, (i) => ({ id: `led_${i}` })), []);
    queuePass(fill(50, (i) => ({ id: `led_${BATCH + i}` })), []);

    const result = await backfillCredits();

    expect(mockDb.select).toHaveBeenCalledTimes(4); // 2 sweeps × 2 passes
    expect(mockSettlePending).toHaveBeenCalledTimes(BATCH + 50);
    expect(result).toEqual({ retried: BATCH + 50, orphans: 0 });
  });

  it('stops after the safety cap even if a sweep keeps returning a full batch', async () => {
    // Every pass returns a full BATCH of orphans (simulating rows that never
    // settle and keep reappearing). The loop must not run unbounded.
    for (let pass = 0; pass < 100; pass++) {
      queuePass([], fill(BATCH, (i) => ({ aiUsageLogId: `aul_${pass}_${i}`, userId: 'u1', cost: 0.01 })));
    }

    const result = await backfillCredits();

    // MAX_PASSES = 50 -> 50 passes × 2 selects.
    expect(mockDb.select).toHaveBeenCalledTimes(100);
    expect(result.orphans).toBe(BATCH * 50);
  });

  it('bills a success:false orphan that carries real cost (errored-but-real spend)', async () => {
    queuePass([], [{ aiUsageLogId: 'aul_err', userId: 'u7', cost: 0.25 }]);

    const result = await backfillCredits();

    expect(mockConsumeCredits).toHaveBeenCalledWith({ aiUsageLogId: 'aul_err', userId: 'u7', costDollars: 0.25 });
    expect(result.orphans).toBe(1);
  });

  it('orphan sweep filters on cost > 0 and no longer excludes by success', async () => {
    mockSelects([], []);
    await backfillCredits();

    // The sweep requires a positive cost (excludes no/zero-cost rows)...
    expect(mockGt).toHaveBeenCalledWith('aul.cost', 0);
    // ...and must NOT gate on success any more.
    expect(mockEq).not.toHaveBeenCalledWith('aul.success', true);
    expect(lastOrphanWhere).toBeDefined();
  });

  it('makes no Stripe calls (reconciliation is local-only)', () => {
    const src = readFileSync(fileURLToPath(new URL('../credit-backfill.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/from ['"]stripe['"]/);
    expect(src).not.toMatch(/stripe\./i);
  });
});
