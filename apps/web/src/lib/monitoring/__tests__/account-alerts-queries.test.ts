import { describe, it, expect, vi, beforeEach } from 'vitest';

// FIFO queue of result sets; each db.select() terminal resolves to the next set.
const resultQueue = vi.hoisted(() => [] as unknown[][]);

const mockSql = vi.hoisted(() => {
  const tag = vi.fn(() => 'SQL') as unknown as { (..._a: unknown[]): string; raw: (s: string) => string };
  tag.raw = vi.fn((s: string) => s) as unknown as (s: string) => string;
  return tag;
});

// Chain whose every builder method returns itself and is awaitable (resolves to the
// next queued set). Covers both terminal shapes: `.groupBy(...)` (drift query) and
// `.limit(...)` (negative-margin query, which also calls .having/.orderBy(asc)).
const makeChain = vi.hoisted(() => () => {
  const rows = resultQueue.length ? resultQueue.shift()! : [];
  const promise = Promise.resolve(rows);
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'groupBy', 'having', 'orderBy', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) => promise.then(resolve, reject);
  return chain;
});

const mockSelect = vi.hoisted(() => vi.fn(() => makeChain()));

vi.mock('@pagespace/db/db', () => ({ db: { select: mockSelect } }));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  aiUsageLogs: { id: 'AI_ID', cost: 'AI_COST' },
  systemLogs: {}, errorLogs: {}, apiMetrics: {}, userActivities: {},
}));
vi.mock('@pagespace/db/schema/credits', () => ({
  creditLedger: {
    userId: 'CL_USER', entryType: 'CL_TYPE', amountCents: 'CL_AMOUNT', appliedCents: 'CL_APPLIED',
    chargeMillicents: 'CL_CHARGE_MC', realCostCents: 'CL_REAL', aiUsageLogId: 'CL_AI_ID', createdAt: 'CL_CREATED',
  },
  creditBalances: {
    userId: 'CB_USER', monthlyRemainingCents: 'CB_MONTHLY', topupRemainingCents: 'CB_TOPUP', debtCents: 'CB_DEBT',
  },
  creditHolds: {},
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'U_ID', name: 'U_NAME', email: 'U_EMAIL' } }));
vi.mock('@pagespace/db/schema/subscriptions', () => ({ subscriptions: {} }));
vi.mock('@pagespace/db/operators', () => ({
  sql: mockSql,
  eq: vi.fn((col: unknown, val: unknown) => ({ type: 'eq', col, val })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  or: vi.fn((...args: unknown[]) => ({ type: 'or', args })),
  gt: vi.fn((col: unknown, val: unknown) => ({ type: 'gt', col, val })),
  gte: vi.fn((col: unknown, val: unknown) => ({ type: 'gte', col, val })),
  lte: vi.fn((col: unknown, val: unknown) => ({ type: 'lte', col, val })),
  asc: vi.fn((col: unknown) => col),
  desc: vi.fn((col: unknown) => col),
  count: vi.fn(() => 'COUNT'),
  inArray: vi.fn((col: unknown, vals: unknown[]) => ({ type: 'inArray', col, vals })),
}));

import { getBalanceDriftAlerts, getNegativeMarginAccounts } from '../monitoring-queries';

function resetQueue(...sets: unknown[][]) {
  resultQueue.length = 0;
  resultQueue.push(...sets);
}

beforeEach(() => {
  vi.clearAllMocks();
  resultQueue.length = 0;
  mockSelect.mockImplementation(() => makeChain());
});

describe('getBalanceDriftAlerts', () => {
  it('returns only flagged accounts, worst drift first, with expected/drift computed', async () => {
    resetQueue([
      // drift 0 → not flagged
      { userId: 'a', userName: null, userEmail: 'a@x', materializedSpendableCents: 700, debtCents: 0, grantCents: 1000, appliedUsageCents: 300, adjustmentCents: 0 },
      // drift +100 → flagged
      { userId: 'b', userName: null, userEmail: 'b@x', materializedSpendableCents: 800, debtCents: 0, grantCents: 1000, appliedUsageCents: 300, adjustmentCents: 0 },
      // drift -50 → flagged
      { userId: 'c', userName: null, userEmail: 'c@x', materializedSpendableCents: 650, debtCents: 0, grantCents: 1000, appliedUsageCents: 300, adjustmentCents: 0 },
    ]);

    const rows = await getBalanceDriftAlerts(10);

    expect(rows.map((r) => r.userId)).toEqual(['b', 'c']); // sorted by |drift| desc
    expect(rows[0]).toMatchObject({ userId: 'b', expectedSpendableCents: 700, driftCents: 100 });
    expect(rows[1]).toMatchObject({ userId: 'c', driftCents: -50 });
    // The flagged helper field is stripped from the returned shape.
    expect('flagged' in rows[0]).toBe(false);
  });

  it('returns nothing when every account is within tolerance', async () => {
    resetQueue([
      { userId: 'a', userName: null, userEmail: null, materializedSpendableCents: 705, debtCents: 0, grantCents: 1000, appliedUsageCents: 300, adjustmentCents: 0 },
    ]);
    expect(await getBalanceDriftAlerts(10)).toEqual([]);
  });
});

describe('getNegativeMarginAccounts', () => {
  it('keeps only accounts whose charged credits fail to cover real cost', async () => {
    resetQueue([
      { userId: 'a', userName: null, userEmail: 'a@x', realCostCents: 100, chargedCents: 90, requestCount: 4 },
      // positive margin — the pure helper drops it even if a loose SQL filter let it through
      { userId: 'b', userName: null, userEmail: 'b@x', realCostCents: 100, chargedCents: 150, requestCount: 2 },
    ]);

    const rows = await getNegativeMarginAccounts(undefined, undefined, 0);

    expect(rows.map((r) => r.userId)).toEqual(['a']);
    expect(rows[0]).toMatchObject({ marginCents: -10, marginPct: -10 });
  });
});
