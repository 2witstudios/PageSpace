import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ────────────────────────────────────────────────────────
// FIFO queue of result sets; each db.select() dequeues the next set in query order.
const resultQueue = vi.hoisted(() => [] as unknown[][]);

const mockEq = vi.hoisted(() => vi.fn((col: unknown, val: unknown) => ({ type: 'eq', col, val })));
const mockGte = vi.hoisted(() => vi.fn((col: unknown, val: unknown) => ({ type: 'gte', col, val })));
const mockLte = vi.hoisted(() => vi.fn((col: unknown, val: unknown) => ({ type: 'lte', col, val })));
const mockAnd = vi.hoisted(() => vi.fn((...args: unknown[]) => ({ type: 'and', args })));
const mockDesc = vi.hoisted(() => vi.fn((col: unknown) => col));
const mockCount = vi.hoisted(() => vi.fn(() => 'COUNT'));
const mockInArray = vi.hoisted(() => vi.fn((col: unknown, vals: unknown) => ({ type: 'inArray', col, vals })));
const mockSql = vi.hoisted(() => {
  const tag = vi.fn(() => 'SQL') as unknown as { (..._a: unknown[]): string; raw: (s: string) => string };
  tag.raw = vi.fn((s: string) => s) as unknown as (s: string) => string;
  return tag;
});
const mockGetTierFromPrice = vi.hoisted(() => vi.fn());

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

vi.mock('@pagespace/db/db', () => ({ db: { select: mockSelect } }));

vi.mock('@pagespace/db/schema/monitoring', () => ({
  aiUsageLogs: {
    id: 'AI_USAGE_ID',
    timestamp: 'AI_USAGE_TIMESTAMP',
    provider: 'AI_USAGE_PROVIDER',
    model: 'AI_USAGE_MODEL',
    cost: 'AI_USAGE_COST',
    inputTokens: 'AI_USAGE_INPUT_TOKENS',
    outputTokens: 'AI_USAGE_OUTPUT_TOKENS',
    totalTokens: 'AI_USAGE_TOTAL_TOKENS',
    userId: 'AI_USAGE_USER_ID',
  },
  systemLogs: {},
  errorLogs: {},
  apiMetrics: {},
  userActivities: {},
}));

vi.mock('@pagespace/db/schema/credits', () => ({
  creditLedger: {
    entryType: 'CREDIT_LEDGER_ENTRY_TYPE',
    amountCents: 'CREDIT_LEDGER_AMOUNT_CENTS',
    chargeMillicents: 'CREDIT_LEDGER_CHARGE_MILLICENTS',
    realCostCents: 'CREDIT_LEDGER_REAL_COST_CENTS',
    aiUsageLogId: 'CREDIT_LEDGER_AI_USAGE_LOG_ID',
    createdAt: 'CREDIT_LEDGER_CREATED_AT',
    userId: 'CREDIT_LEDGER_USER_ID',
  },
  creditBalances: {
    monthlyRemainingCents: 'CB_MONTHLY_REMAINING',
    topupRemainingCents: 'CB_TOPUP_REMAINING',
  },
  creditHolds: {
    estCents: 'CH_EST_CENTS',
    expiresAt: 'CH_EXPIRES_AT',
  },
}));

vi.mock('@pagespace/db/schema/subscriptions', () => ({
  subscriptions: {
    status: 'SUB_STATUS',
    stripePriceId: 'SUB_PRICE_ID',
  },
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'USERS_ID', name: 'USERS_NAME', email: 'USERS_EMAIL' },
}));

vi.mock('@pagespace/db/operators', () => ({
  sql: mockSql,
  eq: mockEq,
  gte: mockGte,
  lte: mockLte,
  and: mockAnd,
  or: vi.fn((...args: unknown[]) => ({ type: 'or', args })),
  desc: mockDesc,
  count: mockCount,
  inArray: mockInArray,
}));

vi.mock('@/lib/stripe/price-config', () => ({
  getTierFromPrice: mockGetTierFromPrice,
}));

import {
  getTokenUsageSummary,
  getTokenUsageByModel,
  getTokenUsageByPeriod,
  getTokenUsageByUser,
  getProviderCostRollup,
  getCreditRevenue,
  getActiveSubscriptionsByTier,
  getCreditLiability,
  getLiveHolds,
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

describe('getTokenUsageSummary', () => {
  it('returns the SUM aggregates and request count', async () => {
    resetQueue([{ inputTokens: 1200, outputTokens: 800, totalTokens: 2000, requestCount: 7 }]);
    const result = await getTokenUsageSummary();
    expect(result).toEqual({ inputTokens: 1200, outputTokens: 800, totalTokens: 2000, requestCount: 7 });
  });

  it('defaults to zeroes on an empty result', async () => {
    resetQueue([]);
    const result = await getTokenUsageSummary();
    expect(result).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0 });
  });

  it('anchors the window on the usage-log timestamp (token usage is a usage-log view)', async () => {
    resetQueue([]);
    const start = new Date('2026-01-01');
    const end = new Date('2026-02-01');
    await getTokenUsageSummary(start, end);
    const gteCols = mockGte.mock.calls.map((c) => c[0]);
    const lteCols = mockLte.mock.calls.map((c) => c[0]);
    expect(gteCols).toContain('AI_USAGE_TIMESTAMP');
    expect(lteCols).toContain('AI_USAGE_TIMESTAMP');
  });
});

describe('getTokenUsageByModel', () => {
  it('returns rows and backfills unknown provider/model', async () => {
    resetQueue([
      { provider: 'openrouter', model: 'anthropic/claude', inputTokens: 10, outputTokens: 5, totalTokens: 15, requestCount: 1 },
      { provider: null, model: null, inputTokens: 2, outputTokens: 1, totalTokens: 3, requestCount: 1 },
    ]);
    const rows = await getTokenUsageByModel();
    expect(rows[0]).toMatchObject({ provider: 'openrouter', model: 'anthropic/claude', totalTokens: 15 });
    expect(rows[1]).toMatchObject({ provider: 'unknown', model: 'unknown' });
  });
});

describe('getTokenUsageByPeriod', () => {
  it('returns period rows', async () => {
    resetQueue([{ period: '2026-01-02', inputTokens: 4, outputTokens: 6, totalTokens: 10, requestCount: 2 }]);
    const rows = await getTokenUsageByPeriod(undefined, undefined, 'day');
    expect(rows[0]).toMatchObject({ period: '2026-01-02', totalTokens: 10 });
  });

  it('rejects an invalid granularity to prevent SQL injection', async () => {
    await expect(
      // @ts-expect-error intentional invalid granularity
      getTokenUsageByPeriod(undefined, undefined, 'day; DROP TABLE'),
    ).rejects.toThrow();
  });
});

describe('getTokenUsageByUser', () => {
  it('returns per-user token rows', async () => {
    resetQueue([
      { userId: 'u1', userName: 'Alice', userEmail: 'a@x.com', inputTokens: 100, outputTokens: 50, totalTokens: 150, requestCount: 3 },
    ]);
    const rows = await getTokenUsageByUser();
    expect(rows[0]).toMatchObject({ userId: 'u1', totalTokens: 150 });
  });
});

describe('getProviderCostRollup', () => {
  it('labels a row real when its costSource is openrouter and computes margin', async () => {
    resetQueue([
      { provider: 'openrouter', model: 'anthropic/claude', costSource: 'openrouter', realCostCents: 100, chargedCents: 150, requestCount: 4 },
    ]);
    const rows = await getProviderCostRollup();
    expect(rows[0]).toMatchObject({
      provider: 'openrouter',
      coverage: 'real',
      marginCents: 50,
      marginPct: 50,
    });
  });

  it('labels coverage from the per-row costSource, NOT the provider name (an OpenRouter call that fell back to the estimate reports estimate)', async () => {
    resetQueue([
      { provider: 'openrouter', model: 'anthropic/claude', costSource: 'openrouter', realCostCents: 100, chargedCents: 150, requestCount: 2 },
      { provider: 'openrouter', model: 'anthropic/claude', costSource: 'estimate', realCostCents: 50, chargedCents: 60, requestCount: 1 },
    ]);
    const rows = await getProviderCostRollup();
    expect(rows[0].coverage).toBe('real');
    // Same provider/model, but this group billed on the static fallback — honest 'estimate'.
    expect(rows[1].coverage).toBe('estimate');
  });

  it('falls back to the provider-name heuristic when metadata (costSource) was purged', async () => {
    resetQueue([
      { provider: 'openrouter_free', model: 'm:free', costSource: null, realCostCents: 0, chargedCents: 0, requestCount: 1 },
      { provider: 'anthropic', model: 'claude', costSource: null, realCostCents: 100, chargedCents: 150, requestCount: 2 },
      { provider: null, model: null, costSource: null, realCostCents: 10, chargedCents: 10, requestCount: 1 },
    ]);
    const rows = await getProviderCostRollup();
    expect(rows[0].coverage).toBe('real'); // openrouter_free → real
    expect(rows[1].coverage).toBe('estimate'); // direct provider → estimate
    expect(rows[2]).toMatchObject({ provider: 'unknown', coverage: 'estimate' });
  });

  it('anchors the window on the ledger createdAt, not the purgeable usage-log timestamp', async () => {
    resetQueue([]);
    await getProviderCostRollup(new Date('2026-01-01'), new Date('2026-02-01'));
    const gteCols = mockGte.mock.calls.map((c) => c[0]);
    expect(gteCols).toContain('CREDIT_LEDGER_CREATED_AT');
    expect(gteCols).not.toContain('AI_USAGE_TIMESTAMP');
  });
});

describe('getCreditRevenue', () => {
  it('splits top-up and monthly-grant revenue and totals them', async () => {
    resetQueue([
      { entryType: 'topup_purchase', cents: 5000, count: 3 },
      { entryType: 'monthly_grant', cents: 2000, count: 10 },
    ]);
    const result = await getCreditRevenue();
    expect(result).toEqual({
      topupCents: 5000,
      topupCount: 3,
      monthlyGrantCents: 2000,
      monthlyGrantCount: 10,
      totalCents: 7000,
    });
  });

  it('filters to the two funding entry types via inArray', async () => {
    resetQueue([]);
    await getCreditRevenue();
    expect(mockInArray).toHaveBeenCalledWith('CREDIT_LEDGER_ENTRY_TYPE', ['topup_purchase', 'monthly_grant']);
  });

  it('defaults to zero when no funding rows exist', async () => {
    resetQueue([]);
    const result = await getCreditRevenue();
    expect(result).toEqual({ topupCents: 0, topupCount: 0, monthlyGrantCents: 0, monthlyGrantCount: 0, totalCents: 0 });
  });
});

describe('getActiveSubscriptionsByTier', () => {
  it('maps each active subscription price to a tier and counts per tier', async () => {
    resetQueue([
      { stripePriceId: 'price_pro' },
      { stripePriceId: 'price_pro' },
      { stripePriceId: 'price_business' },
    ]);
    mockGetTierFromPrice.mockImplementation((priceId: string) =>
      priceId === 'price_business' ? 'business' : 'pro',
    );
    const rows = await getActiveSubscriptionsByTier();
    const byTier = Object.fromEntries(rows.map((r) => [r.tier, r.count]));
    expect(byTier).toEqual({ free: 0, pro: 2, founder: 0, business: 1 });
    expect(mockEq).toHaveBeenCalledWith('SUB_STATUS', 'active');
  });
});

describe('getCreditLiability', () => {
  it('sums monthly + top-up remaining into total liability', async () => {
    resetQueue([{ monthlyRemainingCents: 400, topupRemainingCents: 600, userCount: 12 }]);
    const result = await getCreditLiability();
    expect(result).toEqual({
      monthlyRemainingCents: 400,
      topupRemainingCents: 600,
      totalLiabilityCents: 1000,
      userCount: 12,
    });
  });

  it('defaults to zero on an empty balances table', async () => {
    resetQueue([]);
    const result = await getCreditLiability();
    expect(result).toEqual({ monthlyRemainingCents: 0, topupRemainingCents: 0, totalLiabilityCents: 0, userCount: 0 });
  });
});

describe('getLiveHolds', () => {
  it('returns the count and summed estimate of non-expired holds', async () => {
    resetQueue([{ holdCount: 5, heldCents: 250 }]);
    const result = await getLiveHolds();
    expect(result).toEqual({ holdCount: 5, heldCents: 250 });
  });

  it('defaults to zero when no live holds exist', async () => {
    resetQueue([]);
    const result = await getLiveHolds();
    expect(result).toEqual({ holdCount: 0, heldCents: 0 });
  });
});
