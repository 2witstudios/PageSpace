import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ────────────────────────────────────────────────────────
// A FIFO queue of result sets. Each call to db.select() dequeues the next set,
// in the order the queries run. Tests push the rows they want each query to see.
const resultQueue = vi.hoisted(() => [] as unknown[][]);

const mockEq = vi.hoisted(() => vi.fn((col: unknown, val: unknown) => ({ type: 'eq', col, val })));
const mockGt = vi.hoisted(() => vi.fn((col: unknown, val: unknown) => ({ type: 'gt', col, val })));
const mockGte = vi.hoisted(() => vi.fn((col: unknown, val: unknown) => ({ type: 'gte', col, val })));
const mockLte = vi.hoisted(() => vi.fn((col: unknown, val: unknown) => ({ type: 'lte', col, val })));
const mockAnd = vi.hoisted(() => vi.fn((...args: unknown[]) => ({ type: 'and', args })));
const mockDesc = vi.hoisted(() => vi.fn((col: unknown) => col));
const mockCount = vi.hoisted(() => vi.fn(() => 'COUNT'));
const mockSql = vi.hoisted(() => {
  const tag = vi.fn(() => 'SQL') as unknown as { (..._a: unknown[]): string; raw: (s: string) => string };
  tag.raw = vi.fn((s: string) => s) as unknown as (s: string) => string;
  return tag;
});

// Chainable db mock whose terminal resolves to the next queued result set.
const makeChain = vi.hoisted(() => () => {
  const rows = resultQueue.length ? resultQueue.shift()! : [];
  const promise = Promise.resolve(rows);
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.groupBy = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => promise);
  chain.then = (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
    promise.then(resolve, reject);
  return chain;
});

const mockSelect = vi.hoisted(() => vi.fn(() => makeChain()));

vi.mock('@pagespace/db/db', () => ({
  db: { select: mockSelect },
}));

vi.mock('@pagespace/db/schema/monitoring', () => ({
  aiUsageLogs: {
    id: 'AI_USAGE_ID',
    timestamp: 'AI_USAGE_TIMESTAMP',
    provider: 'AI_USAGE_PROVIDER',
    model: 'AI_USAGE_MODEL',
    cost: 'AI_USAGE_COST',
    totalTokens: 'AI_USAGE_TOTAL_TOKENS',
    success: 'AI_USAGE_SUCCESS',
    userId: 'AI_USAGE_USER_ID',
    conversationId: 'AI_USAGE_CONVERSATION_ID',
  },
  systemLogs: {},
  errorLogs: {},
  apiMetrics: {},
  userActivities: {},
}));

vi.mock('@pagespace/db/schema/credits', () => ({
  creditLedger: {
    id: 'CREDIT_LEDGER_ID',
    userId: 'CREDIT_LEDGER_USER_ID',
    entryType: 'CREDIT_LEDGER_ENTRY_TYPE',
    bucket: 'CREDIT_LEDGER_BUCKET',
    amountCents: 'CREDIT_LEDGER_AMOUNT_CENTS',
    appliedCents: 'CREDIT_LEDGER_APPLIED_CENTS',
    chargeMillicents: 'CREDIT_LEDGER_CHARGE_MILLICENTS',
    realCostCents: 'CREDIT_LEDGER_REAL_COST_CENTS',
    aiUsageLogId: 'CREDIT_LEDGER_AI_USAGE_LOG_ID',
    createdAt: 'CREDIT_LEDGER_CREATED_AT',
  },
  creditBalances: {
    userId: 'CREDIT_BALANCES_USER_ID',
    debtCents: 'CREDIT_BALANCES_DEBT_CENTS',
  },
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'USERS_ID', name: 'USERS_NAME', email: 'USERS_EMAIL' },
}));

vi.mock('@pagespace/db/operators', () => ({
  sql: mockSql,
  eq: mockEq,
  gt: mockGt,
  gte: mockGte,
  lte: mockLte,
  and: mockAnd,
  or: vi.fn((...args: unknown[]) => ({ type: 'or', args })),
  desc: mockDesc,
  count: mockCount,
}));

import {
  computeMarginPct,
  getUnitEconomicsSummary,
  getMarginByPeriod,
  getMarginByModel,
  getTopSpendersByMargin,
  getOutstandingDebtByUser,
} from '../monitoring-queries';

function resetQueue(...sets: unknown[][]) {
  resultQueue.length = 0;
  resultQueue.push(...sets);
}

beforeEach(() => {
  vi.clearAllMocks();
  resultQueue.length = 0;
  mockSelect.mockImplementation(() => makeChain());
});

describe('computeMarginPct', () => {
  it('returns positive margin when charged exceeds real cost', () => {
    expect(computeMarginPct(100, 150)).toBeCloseTo(50);
  });

  it('returns negative margin when charged is below real cost', () => {
    expect(computeMarginPct(200, 150)).toBeCloseTo(-25);
  });

  it('returns null when real cost is zero (margin undefined)', () => {
    expect(computeMarginPct(0, 150)).toBeNull();
  });

  it('returns null when real cost is negative (defensive)', () => {
    expect(computeMarginPct(-10, 150)).toBeNull();
  });

  it('returns 0 when charged equals real cost', () => {
    expect(computeMarginPct(100, 100)).toBe(0);
  });
});

describe('getUnitEconomicsSummary', () => {
  it('combines usage aggregate and debt aggregate into a margin summary', async () => {
    resetQueue(
      [{ realCostCents: 100, chargedCents: 150, appliedCents: 140, requestCount: 3 }],
      [{ debtCents: 10 }],
    );

    const result = await getUnitEconomicsSummary();

    expect(result).toEqual({
      realCostCents: 100,
      chargedCents: 150,
      appliedCents: 140,
      requestCount: 3,
      debtCents: 10,
      marginCents: 50,
      marginPct: 50,
    });
  });

  it('filters the usage aggregate to entryType = usage; debt comes from the balances snapshot, not adjustment rows', async () => {
    resetQueue([{ realCostCents: 0, chargedCents: 0, appliedCents: 0, requestCount: 0 }], [{ debtCents: 0 }]);

    await getUnitEconomicsSummary();

    const eqArgs = mockEq.mock.calls.map((c) => [c[0], c[1]]);
    expect(eqArgs).toContainEqual(['CREDIT_LEDGER_ENTRY_TYPE', 'usage']);
    // Outstanding debt is now the live credit_balances.debtCents snapshot (repaid/forgiven
    // debt is cleared there), NOT a historical sum of 'adjustment' ledger rows.
    expect(eqArgs).not.toContainEqual(['CREDIT_LEDGER_ENTRY_TYPE', 'adjustment']);
  });

  it('handles empty result sets by defaulting to zero', async () => {
    resetQueue([], []);

    const result = await getUnitEconomicsSummary();

    expect(result.realCostCents).toBe(0);
    expect(result.chargedCents).toBe(0);
    expect(result.debtCents).toBe(0);
    expect(result.marginPct).toBeNull();
  });

  it('anchors the date window on creditLedger.createdAt, not the purgeable aiUsageLogs.timestamp', async () => {
    resetQueue([{ realCostCents: 0, chargedCents: 0, appliedCents: 0, requestCount: 0 }], [{ debtCents: 0 }]);
    const start = new Date('2026-01-01');
    const end = new Date('2026-02-01');

    await getUnitEconomicsSummary(start, end);

    const gteCols = mockGte.mock.calls.map((c) => c[0]);
    const lteCols = mockLte.mock.calls.map((c) => c[0]);
    // The usage aggregate filters on the ledger's own createdAt so a ledger row whose
    // aiUsageLog was reaped still counts. (Outstanding debt is a point-in-time snapshot
    // and is intentionally NOT window-filtered.)
    expect(gteCols).toContain('CREDIT_LEDGER_CREATED_AT');
    expect(lteCols).toContain('CREDIT_LEDGER_CREATED_AT');
    // The purgeable usage-log timestamp is never used as the window filter.
    expect(gteCols).not.toContain('AI_USAGE_TIMESTAMP');
    expect(lteCols).not.toContain('AI_USAGE_TIMESTAMP');
  });
});

describe('getMarginByPeriod', () => {
  it('computes margin per period row', async () => {
    resetQueue([
      { period: '2026-01-02', realCostCents: 200, chargedCents: 300, appliedCents: 300, requestCount: 5 },
      { period: '2026-01-01', realCostCents: 100, chargedCents: 100, appliedCents: 100, requestCount: 2 },
    ]);

    const rows = await getMarginByPeriod();

    expect(rows[0]).toMatchObject({ period: '2026-01-02', marginCents: 100, marginPct: 50 });
    expect(rows[1]).toMatchObject({ period: '2026-01-01', marginCents: 0, marginPct: 0 });
  });

  it('rejects an invalid granularity to prevent SQL injection', async () => {
    await expect(
      // @ts-expect-error intentional invalid granularity
      getMarginByPeriod(undefined, undefined, 'day; DROP TABLE'),
    ).rejects.toThrow();
  });
});

describe('getMarginByModel', () => {
  it('returns per model/provider margin', async () => {
    resetQueue([
      { provider: 'anthropic', model: 'claude', realCostCents: 100, chargedCents: 150, appliedCents: 150, requestCount: 4 },
    ]);

    const rows = await getMarginByModel();

    expect(rows[0]).toMatchObject({ provider: 'anthropic', model: 'claude', marginCents: 50, marginPct: 50 });
  });
});

describe('getTopSpendersByMargin', () => {
  it('returns per user margin ordered by charged spend', async () => {
    resetQueue([
      { userId: 'u1', userName: 'Alice', userEmail: 'a@x.com', realCostCents: 100, chargedCents: 150, appliedCents: 150, requestCount: 9 },
    ]);

    const rows = await getTopSpendersByMargin();

    expect(rows[0]).toMatchObject({ userId: 'u1', userName: 'Alice', marginCents: 50, marginPct: 50 });
  });
});

describe('getOutstandingDebtByUser', () => {
  it('returns per-user CURRENT outstanding debt from the balances snapshot (debtCents > 0)', async () => {
    resetQueue([
      { userId: 'u1', userName: 'Alice', userEmail: 'a@x.com', debtCents: 25 },
    ]);

    const rows = await getOutstandingDebtByUser();

    expect(rows[0]).toMatchObject({ userId: 'u1', debtCents: 25 });
    // Sourced from live credit_balances.debtCents (not historical 'adjustment' rows),
    // filtered to users who currently owe (debtCents > 0).
    const eqArgs = mockEq.mock.calls.map((c) => [c[0], c[1]]);
    expect(eqArgs).not.toContainEqual(['CREDIT_LEDGER_ENTRY_TYPE', 'adjustment']);
    const gtArgs = mockGt.mock.calls.map((c) => [c[0], c[1]]);
    expect(gtArgs).toContainEqual(['CREDIT_BALANCES_DEBT_CENTS', 0]);
  });
});
