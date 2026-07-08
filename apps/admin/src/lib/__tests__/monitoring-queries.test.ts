import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ────────────────────────────────────────────────────────
// FIFO queue of result sets; each db.select() dequeues the next set in query order.
const resultQueue = vi.hoisted(() => [] as unknown[][]);

const mockEq = vi.hoisted(() => vi.fn((col: unknown, val: unknown) => ({ type: 'eq', col, val })));
const mockGte = vi.hoisted(() => vi.fn((col: unknown, val: unknown) => ({ type: 'gte', col, val })));
const mockLte = vi.hoisted(() => vi.fn((col: unknown, val: unknown) => ({ type: 'lte', col, val })));
const mockAnd = vi.hoisted(() => vi.fn((...args: unknown[]) => ({ type: 'and', args })));
const mockInArray = vi.hoisted(() => vi.fn((col: unknown, vals: unknown) => ({ type: 'inArray', col, vals })));
const mockSql = vi.hoisted(() => {
  const tag = vi.fn(() => 'SQL') as unknown as { (..._a: unknown[]): string; raw: (s: string) => string };
  tag.raw = vi.fn((s: string) => s) as unknown as (s: string) => string;
  return tag;
});
const mockPricesRetrieve = vi.hoisted(() => vi.fn());

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
  chain.having = vi.fn(() => chain);
  chain.limit = vi.fn(() => promise);
  chain.then = (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
    promise.then(resolve, reject);
  return chain;
});

const mockSelect = vi.hoisted(() => vi.fn(() => makeChain()));

vi.mock('@pagespace/db/db', () => ({ db: { select: mockSelect } }));

vi.mock('@pagespace/db/schema/monitoring', () => ({
  aiUsageLogs: { id: 'AI_ID', timestamp: 'AI_TS', cost: 'AI_COST', provider: 'AI_PROVIDER', model: 'AI_MODEL', inputTokens: 'AI_IN', outputTokens: 'AI_OUT', totalTokens: 'AI_TOTAL', userId: 'AI_USER', metadata: 'AI_META', success: 'AI_SUCCESS' },
  systemLogs: { timestamp: 'SL_TS', level: 'SL_LEVEL', category: 'SL_CATEGORY', ip: 'SL_IP', metadata: 'SL_META' },
  errorLogs: { id: 'EL_ID', timestamp: 'EL_TS', message: 'EL_MSG', name: 'EL_NAME', stack: 'EL_STACK', endpoint: 'EL_ENDPOINT', userId: 'EL_USER' },
  apiMetrics: { timestamp: 'AM_TS', endpoint: 'AM_ENDPOINT', duration: 'AM_DURATION', statusCode: 'AM_STATUS', userId: 'AM_USER' },
  activityLogs: { timestamp: 'AL_TS', userId: 'AL_USER', operation: 'AL_OP' },
}));

vi.mock('@pagespace/db/schema/sessions', () => ({
  sessions: { userId: 'S_USER', lastUsedAt: 'S_LAST_USED', revokedAt: 'S_REVOKED' },
}));

vi.mock('@pagespace/db/schema/credits', () => ({
  creditLedger: { entryType: 'CL_ENTRY_TYPE', amountCents: 'CL_AMOUNT', chargeMillicents: 'CL_CHARGE', appliedCents: 'CL_APPLIED', realCostCents: 'CL_REAL_COST', aiUsageLogId: 'CL_AI_ID', createdAt: 'CL_CREATED', userId: 'CL_USER' },
  creditBalances: { userId: 'CB_USER', monthlyRemainingCents: 'CB_MONTHLY', topupRemainingCents: 'CB_TOPUP', debtCents: 'CB_DEBT' },
  creditHolds: { estCents: 'CH_EST', expiresAt: 'CH_EXPIRES' },
}));

vi.mock('@pagespace/db/schema/subscriptions', () => ({
  subscriptions: { userId: 'SUB_USER', status: 'SUB_STATUS', gifted: 'SUB_GIFTED', stripePriceId: 'SUB_PRICE_ID' },
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'U_ID', name: 'U_NAME', email: 'U_EMAIL', createdAt: 'U_CREATED', subscriptionTier: 'U_TIER' },
}));

vi.mock('@pagespace/db/operators', () => ({
  sql: mockSql,
  eq: mockEq,
  gte: mockGte,
  lte: mockLte,
  and: mockAnd,
  or: vi.fn((...args: unknown[]) => ({ type: 'or', args })),
  gt: vi.fn((col: unknown, val: unknown) => ({ type: 'gt', col, val })),
  lt: vi.fn((col: unknown, val: unknown) => ({ type: 'lt', col, val })),
  asc: vi.fn((col: unknown) => col),
  desc: vi.fn((col: unknown) => col),
  count: vi.fn(() => 'COUNT'),
  inArray: mockInArray,
  isNull: vi.fn((col: unknown) => ({ type: 'isNull', col })),
  isNotNull: vi.fn((col: unknown) => ({ type: 'isNotNull', col })),
}));

vi.mock('@pagespace/lib/billing/credit-core', () => ({
  computeBalanceDrift: vi.fn(),
  isNegativeMargin: vi.fn(),
}));

vi.mock('@pagespace/lib/billing/credit-pricing', () => ({
  BALANCE_DRIFT_TOLERANCE_CENTS: 100,
  NEGATIVE_MARGIN_FLOOR_BPS: 0,
}));

vi.mock('@pagespace/lib/auth/user-repository', () => ({
  decryptUserDisplayFields: vi.fn(async (rows: unknown[]) => rows),
}));

vi.mock('../stripe/client', () => ({
  stripe: { prices: { retrieve: mockPricesRetrieve } },
}));

// Real price-config + real stripe-config (hardcoded, test-mode) + real maskEmail.
import { stripeConfig } from '../stripe-config';
import {
  getActiveSubscriptionsByTier,
  getCreditRevenue,
  getErrorAnalytics,
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

describe('getActiveSubscriptionsByTier', () => {
  it('filters to non-gifted active+trialing subscriptions', async () => {
    resetQueue([]);
    await getActiveSubscriptionsByTier();

    expect(mockInArray).toHaveBeenCalledWith('SUB_STATUS', ['active', 'trialing']);
    expect(mockEq).toHaveBeenCalledWith('SUB_GIFTED', false);
  });

  it('buckets known price IDs via the static map without calling Stripe', async () => {
    resetQueue([
      { stripePriceId: stripeConfig.priceIds.pro },
      { stripePriceId: stripeConfig.priceIds.pro },
      { stripePriceId: stripeConfig.priceIds.business },
    ]);

    const result = await getActiveSubscriptionsByTier();

    expect(mockPricesRetrieve).not.toHaveBeenCalled();
    expect(result).toEqual(expect.arrayContaining([
      { tier: 'free', count: 0 },
      { tier: 'pro', count: 2 },
      { tier: 'founder', count: 0 },
      { tier: 'business', count: 1 },
    ]));
  });

  it('resolves legacy price IDs to a tier via the Stripe unit amount (H2)', async () => {
    resetQueue([
      { stripePriceId: 'price_legacy_pro' },
      { stripePriceId: 'price_legacy_pro' },
      { stripePriceId: stripeConfig.priceIds.founder },
    ]);
    mockPricesRetrieve.mockResolvedValue({ unit_amount: 2999 }); // legacy $29.99 pro

    const result = await getActiveSubscriptionsByTier();

    // One Stripe lookup per DISTINCT legacy price ID, not per subscription row.
    expect(mockPricesRetrieve).toHaveBeenCalledTimes(1);
    expect(mockPricesRetrieve).toHaveBeenCalledWith('price_legacy_pro');
    expect(result).toEqual(expect.arrayContaining([
      { tier: 'pro', count: 2 },
      { tier: 'founder', count: 1 },
      { tier: 'free', count: 0 },
    ]));
  });

  it('falls back to the free bucket when a legacy price cannot be resolved', async () => {
    resetQueue([{ stripePriceId: 'price_gone' }]);
    mockPricesRetrieve.mockRejectedValue(new Error('No such price'));

    const result = await getActiveSubscriptionsByTier();

    expect(result).toEqual(expect.arrayContaining([{ tier: 'free', count: 1 }]));
  });
});

describe('getCreditRevenue', () => {
  it('splits top-up cash from monthly grants and exposes NO combined total', async () => {
    resetQueue([
      { entryType: 'topup_purchase', cents: 500, count: 2 },
      { entryType: 'monthly_grant', cents: 1500, count: 3 },
    ]);

    const result = await getCreditRevenue();

    expect(result).toEqual({
      topupCents: 500,
      topupCount: 2,
      monthlyGrantCents: 1500,
      monthlyGrantCount: 3,
    });
    expect(result).not.toHaveProperty('totalCents');
  });
});

describe('getErrorAnalytics failed-login masking (L4)', () => {
  it('masks email-shaped metadata values before returning them', async () => {
    const ts = new Date('2026-07-08T00:00:00Z');
    resetQueue(
      [], // errorTrends
      [], // errorPatterns
      [{ timestamp: ts, ip: '1.2.3.4', metadata: { email: 'john.doe@example.com', reason: 'bad password' } }],
    );

    const result = await getErrorAnalytics();

    expect(result.failedLogins).toEqual([
      {
        timestamp: ts,
        ip: '1.2.3.4',
        metadata: { email: 'jo***@example.com', reason: 'bad password' },
      },
    ]);
  });

  it('normalises non-object metadata to null', async () => {
    const ts = new Date('2026-07-08T00:00:00Z');
    resetQueue(
      [],
      [],
      [
        { timestamp: ts, ip: null, metadata: 'raw-string' },
        { timestamp: ts, ip: null, metadata: null },
      ],
    );

    const result = await getErrorAnalytics();

    expect(result.failedLogins.map((l) => l.metadata)).toEqual([null, null]);
  });
});
