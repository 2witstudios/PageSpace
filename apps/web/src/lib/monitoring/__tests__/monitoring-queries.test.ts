import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ────────────────────────────────────────────────────────
const mockGte = vi.hoisted(() => vi.fn((col: unknown, val: unknown) => ({ type: 'gte', col, val })));
const mockLte = vi.hoisted(() => vi.fn((col: unknown, val: unknown) => ({ type: 'lte', col, val })));
const mockAnd = vi.hoisted(() => vi.fn((...args: unknown[]) => ({ type: 'and', args })));
const mockDesc = vi.hoisted(() => vi.fn((col: unknown) => col));
const mockCount = vi.hoisted(() => vi.fn(() => 'COUNT'));
const mockSql = vi.hoisted(() => vi.fn(() => 'SQL'));

// Build a chainable db mock that resolves to []
const makeChain = vi.hoisted(() => () => {
  const chain: Record<string, unknown> = {};
  const terminal = () => Promise.resolve([]);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.groupBy = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(terminal);
  chain.innerJoin = vi.fn(() => chain);
  // make the chain itself thenable so await db.select().from().where() works
  chain.then = (resolve: (v: unknown[]) => void) => resolve([]);
  return chain;
});

const mockSelect = vi.hoisted(() => vi.fn(() => makeChain()));

vi.mock('@pagespace/db/db', () => ({
  db: { select: mockSelect },
}));

vi.mock('@pagespace/db/schema/monitoring', () => ({
  systemLogs: {
    timestamp: 'SYSTEM_LOGS_TIMESTAMP',
    level: 'SYSTEM_LOGS_LEVEL',
    category: 'SYSTEM_LOGS_CATEGORY',
    ip: 'SYSTEM_LOGS_IP',
    metadata: 'SYSTEM_LOGS_METADATA',
  },
  errorLogs: {
    id: 'ERROR_LOGS_ID',
    timestamp: 'ERROR_LOGS_TIMESTAMP',
    message: 'ERROR_LOGS_MESSAGE',
    name: 'ERROR_LOGS_NAME',
    stack: 'ERROR_LOGS_STACK',
    endpoint: 'ERROR_LOGS_ENDPOINT',
    userId: 'ERROR_LOGS_USER_ID',
  },
  apiMetrics: {
    timestamp: 'API_METRICS_TIMESTAMP',
    endpoint: 'API_METRICS_ENDPOINT',
    duration: 'API_METRICS_DURATION',
    statusCode: 'API_METRICS_STATUS_CODE',
    userId: 'API_METRICS_USER_ID',
  },
  userActivities: {
    userId: 'USER_ACTIVITIES_USER_ID',
    timestamp: 'USER_ACTIVITIES_TIMESTAMP',
    action: 'USER_ACTIVITIES_ACTION',
  },
  aiUsageLogs: {
    timestamp: 'AI_USAGE_TIMESTAMP',
    provider: 'AI_USAGE_PROVIDER',
    model: 'AI_USAGE_MODEL',
    cost: 'AI_USAGE_COST',
    totalTokens: 'AI_USAGE_TOTAL_TOKENS',
    success: 'AI_USAGE_SUCCESS',
    userId: 'AI_USAGE_USER_ID',
    conversationId: 'AI_USAGE_CONVERSATION_ID',
  },
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'USERS_ID', name: 'USERS_NAME' },
}));

vi.mock('@pagespace/db/operators', () => ({
  sql: mockSql,
  gte: mockGte,
  lte: mockLte,
  and: mockAnd,
  or: vi.fn((...args: unknown[]) => ({ type: 'or', args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ type: 'eq', col, val })),
  desc: mockDesc,
  count: mockCount,
}));

import { getSystemHealth } from '../monitoring-queries';

describe('getSystemHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockImplementation(() => makeChain());
  });

  it('uses errorLogs.timestamp (not systemLogs.timestamp) for errorConditions when startDate provided', async () => {
    const startDate = new Date('2024-01-01');

    await getSystemHealth(startDate);

    const gteCalls = mockGte.mock.calls;
    const gteColumns = gteCalls.map((call) => call[0]);

    // errorConditions must use errorLogs.timestamp
    expect(gteColumns).toContain('ERROR_LOGS_TIMESTAMP');
    // systemLogs.timestamp is used exactly once (for logConditions only)
    const systemLogGteCalls = gteCalls.filter((call) => call[0] === 'SYSTEM_LOGS_TIMESTAMP');
    expect(systemLogGteCalls).toHaveLength(1);
  });

  it('uses errorLogs.timestamp for errorConditions when endDate provided', async () => {
    const endDate = new Date('2024-01-31');

    await getSystemHealth(undefined, endDate);

    const lteCalls = mockLte.mock.calls;
    const lteColumns = lteCalls.map((call) => call[0]);

    expect(lteColumns).toContain('ERROR_LOGS_TIMESTAMP');
    const systemLogLteCalls = lteCalls.filter((call) => call[0] === 'SYSTEM_LOGS_TIMESTAMP');
    expect(systemLogLteCalls).toHaveLength(1);
  });

  it('uses errorLogs.timestamp for errorConditions with both startDate and endDate', async () => {
    const startDate = new Date('2024-01-01');
    const endDate = new Date('2024-01-31');

    await getSystemHealth(startDate, endDate);

    const gteCols = mockGte.mock.calls.map((call) => call[0]);
    const lteCols = mockLte.mock.calls.map((call) => call[0]);

    expect(gteCols).toContain('ERROR_LOGS_TIMESTAMP');
    expect(lteCols).toContain('ERROR_LOGS_TIMESTAMP');
    // systemLogs.timestamp appears exactly once each (for logConditions, not errorConditions)
    expect(gteCols.filter((c) => c === 'SYSTEM_LOGS_TIMESTAMP')).toHaveLength(1);
    expect(lteCols.filter((c) => c === 'SYSTEM_LOGS_TIMESTAMP')).toHaveLength(1);
  });

  it('applies no where conditions when no dates provided', async () => {
    await getSystemHealth();

    // gte/lte should only be called for the fixed 15-minute active-user window, not for log/error filters
    const gteCols = mockGte.mock.calls.map((call) => call[0]);
    expect(gteCols).not.toContain('SYSTEM_LOGS_TIMESTAMP');
    expect(gteCols).not.toContain('ERROR_LOGS_TIMESTAMP');
  });
});
