/**
 * Flag-gated READ cutover for the admin monitoring queries (#890 Phase 3
 * leaf 3): with CLICKHOUSE_ENABLED the 4 analytics tables are queried from
 * ClickHouse (server-side lib readers); with the flag off the PG path runs
 * exactly as before. getUserActivity is pinned as PG-only — it reads
 * activityLogs (Phase 5 territory), not one of the 4 moved tables.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resultQueue = vi.hoisted(() => [] as unknown[][]);

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

// CH gate + readers (hoisted so the vi.mock factories can reference them).
const mockIsClickHouseEnabled = vi.hoisted(() => vi.fn(() => false));
const fakeClient = vi.hoisted(() => ({ __fake: 'clickhouse-client' }));
const chReads = vi.hoisted(() => ({
  getLogsByLevel: vi.fn(),
  getErrorTrends: vi.fn(),
  getFailedLogins: vi.fn(),
  getRecentErrors: vi.fn(),
  getErrorPatterns: vi.fn(),
  getVolumeOverTime: vi.fn(),
  getTopEndpoints: vi.fn(),
  getRequestErrorCounts: vi.fn(),
  getResponseTimes: vi.fn(),
  getSlowQueries: vi.fn(),
  getEndpointPerformance: vi.fn(),
  getActivityHeatmap: vi.fn(),
  getMostActiveUsers: vi.fn(),
  getFeatureUsage: vi.fn(),
  getActiveUserCount: vi.fn(),
}));

vi.mock('@pagespace/lib/observability/clickhouse-client', () => ({
  isClickHouseEnabled: mockIsClickHouseEnabled,
  getClickHouseClient: vi.fn(() => fakeClient),
}));

vi.mock('@pagespace/lib/observability/analytics-reads', () => chReads);

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
  sql: (() => {
    const tag = vi.fn(() => 'SQL') as unknown as { (..._a: unknown[]): string; raw: (s: string) => string };
    tag.raw = ((s: string) => s) as (s: string) => string;
    return tag;
  })(),
  eq: vi.fn((col: unknown, val: unknown) => ({ type: 'eq', col, val })),
  gte: vi.fn((col: unknown, val: unknown) => ({ type: 'gte', col, val })),
  lte: vi.fn((col: unknown, val: unknown) => ({ type: 'lte', col, val })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  or: vi.fn((...args: unknown[]) => ({ type: 'or', args })),
  gt: vi.fn((col: unknown, val: unknown) => ({ type: 'gt', col, val })),
  lt: vi.fn((col: unknown, val: unknown) => ({ type: 'lt', col, val })),
  asc: vi.fn((col: unknown) => col),
  desc: vi.fn((col: unknown) => col),
  count: vi.fn(() => 'COUNT'),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ type: 'inArray', col, vals })),
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
  stripe: { prices: { retrieve: vi.fn() } },
}));

import {
  getSystemHealth,
  getApiMetrics,
  getErrorAnalytics,
  getUserActivity,
} from '../monitoring-queries';

const TS = new Date('2026-07-01T10:30:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  resultQueue.length = 0;
  mockSelect.mockImplementation(() => makeChain());
  mockIsClickHouseEnabled.mockReturnValue(false);
});

describe('given CLICKHOUSE_ENABLED off', () => {
  it('should never touch the ClickHouse readers', async () => {
    await getSystemHealth();
    await getApiMetrics();
    await getErrorAnalytics();
    for (const fn of Object.values(chReads)) expect(fn).not.toHaveBeenCalled();
    expect(mockSelect).toHaveBeenCalled();
  });
});

describe('given CLICKHOUSE_ENABLED on', () => {
  beforeEach(() => {
    mockIsClickHouseEnabled.mockReturnValue(true);
  });

  it('getSystemHealth should read logs/errors from CH but active users from PG sessions', async () => {
    chReads.getLogsByLevel.mockResolvedValue([{ level: 'error', count: 2 }]);
    chReads.getRecentErrors.mockResolvedValue([
      {
        id: 'e1',
        timestamp: TS,
        message: 'boom',
        errorName: 'TypeError',
        errorMessage: null,
        endpoint: '/api/x',
        userId: null,
      },
    ]);
    resultQueue.push([{ count: 5 }]); // sessions active-user query stays PG

    const result = await getSystemHealth(TS);

    expect(chReads.getLogsByLevel).toHaveBeenCalledWith(fakeClient, {
      startDate: TS,
      endDate: undefined,
    });
    expect(chReads.getRecentErrors).toHaveBeenCalledWith(
      fakeClient,
      { startDate: TS, endDate: undefined },
      20,
    );
    expect(result.logsByLevel).toEqual([{ level: 'error', count: 2 }]);
    // stack was null → falls back to message, exactly like the PG mapping
    expect(result.recentErrors[0].errorMessage).toBe('boom');
    expect(result.activeUserCount).toBe(5);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('getApiMetrics should aggregate in CH SQL and compute the error rate from countIf', async () => {
    chReads.getVolumeOverTime.mockResolvedValue([
      { hour: TS, count: 4, avg_response_time: 12.5 },
    ]);
    chReads.getTopEndpoints.mockResolvedValue([
      { endpoint: '/api/x', count: 4, avgResponseTime: 12.5 },
    ]);
    chReads.getRequestErrorCounts.mockResolvedValue({ total: 8, errors: 2 });

    const result = await getApiMetrics(TS);

    expect(result.volumeOverTime).toEqual([{ hour: TS, count: 4, avg_response_time: 12.5 }]);
    expect(result.topEndpoints).toEqual([{ endpoint: '/api/x', count: 4, avgResponseTime: 12.5 }]);
    expect(result.errorRate).toBe(25);
    expect(result.totalRequests).toBe(8);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('getApiMetrics should report a 0 error rate on an empty window', async () => {
    chReads.getVolumeOverTime.mockResolvedValue([]);
    chReads.getTopEndpoints.mockResolvedValue([]);
    chReads.getRequestErrorCounts.mockResolvedValue({ total: 0, errors: 0 });

    const result = await getApiMetrics();
    expect(result.errorRate).toBe(0);
    expect(result.totalRequests).toBe(0);
  });

  it('getErrorAnalytics should keep the PG output massaging (other-category, count strings, masked emails)', async () => {
    chReads.getErrorTrends.mockResolvedValue([{ hour: TS, category: null, count: 3 }]);
    chReads.getErrorPatterns.mockResolvedValue([{ name: 'E', endpoint: null, count: 4 }]);
    chReads.getFailedLogins.mockResolvedValue([
      { timestamp: TS, ip: '1.2.3.4', metadata: { detail: 'login failed for jane@example.com' } },
    ]);

    const result = await getErrorAnalytics(TS);

    expect(result.errorTrends).toEqual([{ hour: TS, category: 'other', count: '3' }]);
    expect(result.errorPatterns).toEqual([{ name: 'E', category: 'general', count: 4 }]);
    const metadata = result.failedLogins[0].metadata as { detail: string };
    expect(metadata.detail).not.toContain('jane@example.com');
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('getUserActivity should STAY on PG — it reads activityLogs, not one of the 4 moved tables', async () => {
    resultQueue.push([], [], []);
    await getUserActivity(TS);

    expect(chReads.getActivityHeatmap).not.toHaveBeenCalled();
    expect(chReads.getMostActiveUsers).not.toHaveBeenCalled();
    expect(chReads.getFeatureUsage).not.toHaveBeenCalled();
    expect(mockSelect).toHaveBeenCalledTimes(3);
  });
});
