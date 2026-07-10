/**
 * Flag-gated READ cutover for the web monitoring queries (#890 Phase 3
 * leaf 3): with CLICKHOUSE_ENABLED the readers over the 4 moved analytics
 * tables query ClickHouse via the server-side lib readers; flag off, the PG
 * path runs exactly as before. Web's getUserActivity reads userActivities
 * (moved), so it converts its users JOIN to the two-step cross-store lookup.
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
const mockInArray = vi.hoisted(() => vi.fn((col: unknown, vals: unknown) => ({ type: 'inArray', col, vals })));

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
  systemLogs: { timestamp: 'SL_TS', level: 'SL_LEVEL', category: 'SL_CATEGORY', ip: 'SL_IP', metadata: 'SL_META' },
  errorLogs: { id: 'EL_ID', timestamp: 'EL_TS', message: 'EL_MSG', name: 'EL_NAME', stack: 'EL_STACK', endpoint: 'EL_ENDPOINT', userId: 'EL_USER' },
  apiMetrics: { timestamp: 'AM_TS', endpoint: 'AM_ENDPOINT', duration: 'AM_DURATION', statusCode: 'AM_STATUS', userId: 'AM_USER' },
  userActivities: { userId: 'UA_USER', timestamp: 'UA_TS', action: 'UA_ACTION' },
  aiUsageLogs: { timestamp: 'AI_TS', provider: 'AI_PROVIDER', model: 'AI_MODEL', cost: 'AI_COST', totalTokens: 'AI_TOTAL', inputTokens: 'AI_IN', outputTokens: 'AI_OUT', success: 'AI_SUCCESS', userId: 'AI_USER', conversationId: 'AI_CONV', id: 'AI_ID', metadata: 'AI_META' },
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'U_ID', name: 'U_NAME', email: 'U_EMAIL' },
}));

vi.mock('@pagespace/db/schema/credits', () => ({
  creditLedger: { entryType: 'CL_ENTRY_TYPE', amountCents: 'CL_AMOUNT', chargeMillicents: 'CL_CHARGE', appliedCents: 'CL_APPLIED', realCostCents: 'CL_REAL_COST', aiUsageLogId: 'CL_AI_ID', createdAt: 'CL_CREATED', userId: 'CL_USER' },
  creditBalances: { userId: 'CB_USER', monthlyRemainingCents: 'CB_MONTHLY', topupRemainingCents: 'CB_TOPUP', debtCents: 'CB_DEBT' },
  creditHolds: { estCents: 'CH_EST', expiresAt: 'CH_EXPIRES' },
}));

vi.mock('@pagespace/db/schema/subscriptions', () => ({
  subscriptions: { status: 'SUB_STATUS', stripePriceId: 'SUB_PRICE_ID' },
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
  asc: vi.fn((col: unknown) => col),
  desc: vi.fn((col: unknown) => col),
  count: vi.fn(() => 'COUNT'),
  inArray: mockInArray,
}));

vi.mock('@pagespace/lib/auth/user-repository', () => ({
  decryptUserDisplayFields: vi.fn(async (rows: unknown[]) => rows),
}));

import {
  getSystemHealth,
  getApiMetrics,
  getUserActivity,
  getErrorAnalytics,
  getPerformanceMetrics,
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
    await getUserActivity();
    await getErrorAnalytics();
    await getPerformanceMetrics();
    for (const fn of Object.values(chReads)) expect(fn).not.toHaveBeenCalled();
    expect(mockSelect).toHaveBeenCalled();
  });
});

describe('given CLICKHOUSE_ENABLED on', () => {
  beforeEach(() => {
    mockIsClickHouseEnabled.mockReturnValue(true);
  });

  it('getSystemHealth should read logs, errors AND the active-user count from CH', async () => {
    chReads.getLogsByLevel.mockResolvedValue([{ level: 'warn', count: 1 }]);
    chReads.getRecentErrors.mockResolvedValue([
      { id: 'e1', timestamp: TS, message: 'boom', errorName: 'E', errorMessage: 'stack', endpoint: null, userId: null },
    ]);
    chReads.getActiveUserCount.mockResolvedValue(3);

    const result = await getSystemHealth(TS);

    expect(chReads.getActiveUserCount).toHaveBeenCalledWith(fakeClient, expect.any(Date));
    expect(result.logsByLevel).toEqual([{ level: 'warn', count: 1 }]);
    expect(result.recentErrors[0].errorMessage).toBe('stack');
    expect(result.activeUserCount).toBe(3);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('getApiMetrics should aggregate in CH SQL', async () => {
    chReads.getVolumeOverTime.mockResolvedValue([]);
    chReads.getTopEndpoints.mockResolvedValue([]);
    chReads.getRequestErrorCounts.mockResolvedValue({ total: 10, errors: 1 });

    const result = await getApiMetrics(TS);

    expect(result.errorRate).toBe(10);
    expect(result.totalRequests).toBe(10);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('getUserActivity should fetch CH aggregates then look users up in PG (two-step, no SQL join)', async () => {
    chReads.getActivityHeatmap.mockResolvedValue([
      { day_of_week: 3, hour_of_day: 10, activity_count: 2 },
    ]);
    chReads.getMostActiveUsers.mockResolvedValue([
      { userId: 'u1', actionCount: 9 },
      { userId: 'ghost', actionCount: 5 }, // deleted user: PG lookup misses → dropped (inner-join parity)
      { userId: 'u2', actionCount: 1 },
    ]);
    chReads.getFeatureUsage.mockResolvedValue([{ action: 'create', count: 4 }]);
    resultQueue.push([
      { id: 'u1', name: 'Alice' },
      { id: 'u2', name: 'Bob' },
    ]);

    const result = await getUserActivity(TS);

    expect(chReads.getMostActiveUsers).toHaveBeenCalledWith(
      fakeClient,
      { startDate: TS, endDate: undefined },
      100,
    );
    expect(mockInArray).toHaveBeenCalledWith('U_ID', ['u1', 'ghost', 'u2']);
    expect(result.heatmapData).toEqual([{ day_of_week: 3, hour_of_day: 10, activity_count: 2 }]);
    expect(result.mostActiveUsers).toEqual([
      { userId: 'u1', userName: 'Alice', actionCount: 9 },
      { userId: 'u2', userName: 'Bob', actionCount: 1 },
    ]);
    expect(result.featureUsage).toEqual([{ action: 'create', count: 4 }]);
  });

  it('getUserActivity should skip the PG user lookup entirely when CH returns no activity', async () => {
    chReads.getActivityHeatmap.mockResolvedValue([]);
    chReads.getMostActiveUsers.mockResolvedValue([]);
    chReads.getFeatureUsage.mockResolvedValue([]);

    const result = await getUserActivity();

    expect(result.mostActiveUsers).toEqual([]);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('getErrorAnalytics should keep the PG output massaging (web passes metadata through unmasked)', async () => {
    chReads.getErrorTrends.mockResolvedValue([{ hour: TS, category: 'api', count: 2 }]);
    chReads.getErrorPatterns.mockResolvedValue([{ name: 'E', endpoint: '/x', count: 1 }]);
    chReads.getFailedLogins.mockResolvedValue([
      { timestamp: TS, ip: null, metadata: { reason: 'bad password' } },
    ]);

    const result = await getErrorAnalytics(TS);

    expect(result.errorTrends).toEqual([{ hour: TS, category: 'api', count: '2' }]);
    expect(result.errorPatterns).toEqual([{ name: 'E', category: '/x', count: 1 }]);
    expect(result.failedLogins).toEqual([
      { timestamp: TS, ip: null, metadata: { reason: 'bad password' } },
    ]);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('getPerformanceMetrics should read response times, slow queries and per-endpoint stats from CH', async () => {
    chReads.getResponseTimes.mockResolvedValue([
      { hour: TS, avg_response_time: 5, max_response_time: 9, min_response_time: 1 },
    ]);
    chReads.getSlowQueries.mockResolvedValue([
      { endpoint: '/slow', responseTime: 6000, timestamp: TS, userId: null },
    ]);
    chReads.getEndpointPerformance.mockResolvedValue([{ metric: '/x', avgValue: 5, count: 2 }]);

    const result = await getPerformanceMetrics(TS);

    expect(result.responseTimes).toEqual([
      { hour: TS, avg_response_time: 5, max_response_time: 9, min_response_time: 1 },
    ]);
    expect(result.slowQueries).toEqual([
      { endpoint: '/slow', responseTime: 6000, timestamp: TS, userId: null },
    ]);
    expect(result.metricTypes).toEqual([{ metric: '/x', avgValue: 5, count: 2 }]);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
