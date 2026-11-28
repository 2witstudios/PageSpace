import { describe, it, expect, vi, beforeEach } from 'vitest';

// FIFO queue of result sets; each db.select() terminal resolves to the next set.
const resultQueue = vi.hoisted(() => [] as unknown[][]);
// Every builder call any query made, as [method, ...args], in call order.
const chainCalls = vi.hoisted(() => [] as unknown[][]);
const PERSONAL_ROOT = vi.hoisted(() => ({ personalRoot: true }));

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
    chain[m] = vi.fn((...args: unknown[]) => {
      chainCalls.push([m, ...args]);
      return chain;
    });
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
    userId: 'CL_USER', walletId: 'CL_WALLET', entryType: 'CL_TYPE', amountCents: 'CL_AMOUNT', appliedCents: 'CL_APPLIED',
    chargeMillicents: 'CL_CHARGE_MC', realCostCents: 'CL_REAL', aiUsageLogId: 'CL_AI_ID', createdAt: 'CL_CREATED',
  },
  creditHolds: {},
}));
vi.mock('@pagespace/db/schema/wallets', () => ({
  wallets: {
    id: 'W_ID', userId: 'CB_USER', monthlyRemainingCents: 'CB_MONTHLY', topupRemainingCents: 'CB_TOPUP', debtCents: 'CB_DEBT',
  },
  isPersonalRootWallet: vi.fn(() => PERSONAL_ROOT),
  personalRootWalletOf: vi.fn((userId: string) => ({ personalRootOf: userId })),
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

const mockWalletDriftAlerts = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/billing/wallet-reconcile', () => ({ walletDriftAlerts: mockWalletDriftAlerts }));

import { getBalanceDriftAlerts, getNegativeMarginAccounts } from '../monitoring-queries';

function resetQueue(...sets: unknown[][]) {
  resultQueue.length = 0;
  resultQueue.push(...sets);
}

beforeEach(() => {
  vi.clearAllMocks();
  resultQueue.length = 0;
  chainCalls.length = 0;
  mockSelect.mockImplementation(() => makeChain());
});

describe('getBalanceDriftAlerts', () => {
  it('WAL-5 (partial) reads every drifted WALLET through the one lib reader and names the person behind a personal one', async () => {
    mockWalletDriftAlerts.mockResolvedValueOnce([
      { walletId: 'w-root', kind: 'personal_root', ownerType: 'user', userId: 'u1', orgId: null, subjectType: null, subjectId: null, expectedNetCents: 700, materializedNetCents: 800, driftCents: 100, debtCents: 0 },
      { walletId: 'w-pool', kind: 'org_pool', ownerType: 'org', userId: null, orgId: 'o1', subjectType: null, subjectId: null, expectedNetCents: 5000, materializedNetCents: 4950, driftCents: -50, debtCents: 0 },
    ]);
    resetQueue([{ userId: 'u1', userName: 'Una', userEmail: 'u1@x' }]);

    const rows = await getBalanceDriftAlerts(10, 20);

    expect(mockWalletDriftAlerts).toHaveBeenCalledWith({ toleranceCents: 10, limit: 20 });
    expect(rows).toEqual([
      { walletId: 'w-root', walletKind: 'personal_root', userId: 'u1', userName: 'Una', userEmail: 'u1@x', orgId: null, subjectId: null, expectedNetCents: 700, materializedNetCents: 800, driftCents: 100, debtCents: 0 },
      { walletId: 'w-pool', walletKind: 'org_pool', userId: null, userName: null, userEmail: null, orgId: 'o1', subjectId: null, expectedNetCents: 5000, materializedNetCents: 4950, driftCents: -50, debtCents: 0 },
    ]);
  });

  it('reads no people when no wallet drifted', async () => {
    mockWalletDriftAlerts.mockResolvedValueOnce([]);
    expect(await getBalanceDriftAlerts(10)).toEqual([]);
    expect(mockSelect).not.toHaveBeenCalled();
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

  it('clamps a negative margin floor to 0 (SQL and JS filters stay in agreement)', async () => {
    resetQueue([
      { userId: 'a', userName: null, userEmail: 'a@x', realCostCents: 100, chargedCents: 90, requestCount: 1 },
    ]);

    // A negative override must behave like 0 — charged<real still flags, no silent drop.
    const rows = await getNegativeMarginAccounts(undefined, undefined, -5000);

    expect(rows.map((r) => r.userId)).toEqual(['a']);
  });
});
