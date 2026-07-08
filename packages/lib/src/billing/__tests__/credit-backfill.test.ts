import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const mockIsBillingEnabled = vi.hoisted(() => vi.fn(() => true));
const mockConsumeCredits = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSettlePending = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDb = vi.hoisted(() => ({ select: vi.fn(), transaction: vi.fn(), delete: vi.fn() }));
const mockAiLogger = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn() }));

vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/schema/credits', () => ({
  creditBalances: { userId: 'cb.userId' },
  creditLedger: { id: 'cl.id', aiUsageLogId: 'cl.aiUsageLogId', consumeStatus: 'cl.consumeStatus', createdAt: 'cl.createdAt' },
  creditHolds: { id: 'ch.id', expiresAt: 'ch.expiresAt' },
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  aiUsageLogs: { id: 'aul.id', userId: 'aul.userId', cost: 'aul.cost', success: 'aul.success', timestamp: 'aul.timestamp', source: 'aul.source' },
}));
const mockEq = vi.hoisted(() => vi.fn((a, b) => ({ op: 'eq', a, b })));
const mockGt = vi.hoisted(() => vi.fn((a, b) => ({ op: 'gt', a, b })));
vi.mock('@pagespace/db/operators', () => ({
  eq: mockEq,
  and: vi.fn((...a) => ({ op: 'and', a })),
  lt: vi.fn((a, b) => ({ op: 'lt', a, b })),
  gt: mockGt,
  isNull: vi.fn((a) => ({ op: 'isNull', a })),
  notInArray: vi.fn((a, b) => ({ op: 'notInArray', a, b })),
}));
vi.mock('../../deployment-mode', () => ({ isBillingEnabled: mockIsBillingEnabled }));
vi.mock('../../logging/logger-config', () => ({ loggers: { ai: mockAiLogger } }));
vi.mock('../credit-consume', () => ({
  consumeCredits: mockConsumeCredits,
  settlePendingLedgerRow: mockSettlePending,
}));
const mockEmitCreditsUpdated = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../credit-emit', () => ({ emitCreditsUpdated: mockEmitCreditsUpdated }));

import { backfillCredits } from '../credit-backfill';
import { TERMINAL_MARKUP_BPS } from '../credit-pricing';

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
    // Hold-expiry sweep runs once at the start of every backfill; default to nothing
    // expired so the existing pending/orphan assertions are unaffected.
    mockDb.delete.mockReturnValue({ where: () => ({ returning: () => Promise.resolve([]) }) });
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
    expect(result).toEqual({ retried: 2, orphans: 1, expiredHolds: 0 });
  });

  it('does nothing when billing is disabled', async () => {
    mockIsBillingEnabled.mockReturnValue(false);
    const result = await backfillCredits();
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
    expect(result).toEqual({ retried: 0, orphans: 0, expiredHolds: 0 });
  });

  it('is a no-op when nothing is unsettled', async () => {
    mockSelects([], []);
    const result = await backfillCredits();
    expect(mockSettlePending).not.toHaveBeenCalled();
    expect(mockConsumeCredits).not.toHaveBeenCalled();
    expect(result).toEqual({ retried: 0, orphans: 0, expiredHolds: 0 });
  });

  it('sweeps holds past their expiresAt, reports the count, and pushes each affected user once', async () => {
    // Three stale holds (crashed/abandoned streams) reclaimed; two belong to u1, one
    // to u2 — reclaiming raises their spendable, so each distinct owner gets one push.
    mockDb.delete.mockReturnValue({
      where: () => ({ returning: () => Promise.resolve([
        { id: 'h1', userId: 'u1' },
        { id: 'h2', userId: 'u1' },
        { id: 'h3', userId: 'u2' },
      ]) }),
    });
    mockSelects([], []);

    const result = await backfillCredits();

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(result.expiredHolds).toBe(3);
    // One push per distinct user (deduped), not one per hold.
    expect(mockEmitCreditsUpdated).toHaveBeenCalledTimes(2);
    expect(mockEmitCreditsUpdated).toHaveBeenCalledWith('u1');
    expect(mockEmitCreditsUpdated).toHaveBeenCalledWith('u2');
  });

  it('drains a >BATCH backlog across multiple passes (does not stop at one batch)', async () => {
    // Pass 0 returns a full BATCH of pending rows -> more may remain, loop again.
    // Pass 1 returns fewer than BATCH -> drained, stop.
    queuePass(fill(BATCH, (i) => ({ id: `led_${i}` })), []);
    queuePass(fill(50, (i) => ({ id: `led_${BATCH + i}` })), []);

    const result = await backfillCredits();

    expect(mockDb.select).toHaveBeenCalledTimes(4); // 2 sweeps × 2 passes
    expect(mockSettlePending).toHaveBeenCalledTimes(BATCH + 50);
    expect(result).toEqual({ retried: BATCH + 50, orphans: 0, expiredHolds: 0 });
  });

  it('stops after the safety cap even if a sweep keeps returning a full batch of fresh rows', async () => {
    // Every pass returns a full BATCH of DISTINCT orphans (forward progress each
    // pass, so the no-progress break never fires). The cap must still bound it.
    for (let pass = 0; pass < 100; pass++) {
      queuePass([], fill(BATCH, (i) => ({ aiUsageLogId: `aul_${pass}_${i}`, userId: 'u1', cost: 0.01 })));
    }

    const result = await backfillCredits();

    // MAX_PASSES = 50 -> 50 passes × 2 selects.
    expect(mockDb.select).toHaveBeenCalledTimes(100);
    expect(result.orphans).toBe(BATCH * 50);
    // The cap (not natural drain) terminated the loop, so it must warn.
    expect(mockAiLogger.debug).toHaveBeenCalledWith(
      'credit backfill hit MAX_PASSES; backlog may remain',
      expect.any(Object),
    );
  });

  it('stops early (no-progress break) when a full batch of unprocessable rows repeats', async () => {
    // A balance-less pending row stays 'pending' (decrementAndSettle no-ops), so
    // every pass re-fetches the SAME full batch. The loop must detect no forward
    // progress and stop after the second pass — not re-attempt it MAX_PASSES times.
    const stuck = fill(BATCH, (i) => ({ id: `led_stuck_${i}` }));
    for (let pass = 0; pass < 100; pass++) queuePass([...stuck], []);

    const result = await backfillCredits();

    // Pass 0 + pass 1 (identical fingerprint detected) = 2 passes × 2 selects.
    expect(mockDb.select).toHaveBeenCalledTimes(4);
    expect(mockSettlePending).toHaveBeenCalledTimes(BATCH * 2);
    expect(result.retried).toBe(BATCH * 2);
    // Stalled, not capped -> no MAX_PASSES warning.
    expect(mockAiLogger.debug).not.toHaveBeenCalledWith(
      'credit backfill hit MAX_PASSES; backlog may remain',
      expect.any(Object),
    );
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

  it("recovers a source:'terminal' orphan at TERMINAL_MARKUP_BPS instead of the shared default markup", async () => {
    // The crash-recovery gap Codex flagged on PR #1955: a terminal usage row that
    // reached aiUsageLogs but crashed before consumeCredits claimed a ledger row
    // has no stored markup to replay — this sweep must reconstruct it from the
    // row's `source` field, not silently bill it at the general AI markup.
    queuePass([], [{ aiUsageLogId: 'aul_term', userId: 'u_term', cost: 0.02, source: 'terminal' }]);

    await backfillCredits();

    expect(mockConsumeCredits).toHaveBeenCalledWith({
      aiUsageLogId: 'aul_term',
      userId: 'u_term',
      costDollars: 0.02,
      markupBpsOverride: TERMINAL_MARKUP_BPS,
    });
  });

  it('does not apply a markup override to a non-terminal orphan (unchanged behavior)', async () => {
    queuePass([], [{ aiUsageLogId: 'aul_9', userId: 'u9', cost: 0.5, source: 'chat' }]);

    await backfillCredits();

    const call = mockConsumeCredits.mock.calls[0][0];
    expect(call.markupBpsOverride).toBeUndefined();
  });

  it('makes no Stripe calls (reconciliation is local-only)', () => {
    const src = readFileSync(fileURLToPath(new URL('../credit-backfill.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/from ['"]stripe['"]/);
    expect(src).not.toMatch(/stripe\./i);
  });
});
