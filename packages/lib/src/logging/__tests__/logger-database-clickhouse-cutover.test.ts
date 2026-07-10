/**
 * Flag-gated cutover of the 4 analytics tables' writes (#890 Phase 3 leaf 2).
 *
 * CLICKHOUSE_ENABLED off → PG writes exactly as today (pinned by the sibling
 * logger-database.test.ts, which runs with the real flag check and no CH env).
 * On → the ClickHouse insert adapters take the row and the main PG is never
 * touched for api_metrics / system_logs / user_activities / error_logs.
 * ai_usage_logs stays PG in BOTH modes (Phase 4 CDC).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInsert = vi.hoisted(() => vi.fn());
const mockValues = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockIsClickHouseEnabled = vi.hoisted(() => vi.fn());
const mockInsertApiMetric = vi.hoisted(() => vi.fn());
const mockInsertSystemLog = vi.hoisted(() => vi.fn());
const mockInsertUserActivity = vi.hoisted(() => vi.fn());
const mockInsertError = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db/db', () => ({
  db: { insert: mockInsert },
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  systemLogs: { tableName: 'system_logs' },
  apiMetrics: { tableName: 'api_metrics' },
  aiUsageLogs: { tableName: 'ai_usage_logs' },
  errorLogs: { tableName: 'error_logs' },
  userActivities: { tableName: 'user_activities' },
}));
vi.mock('../../deployment-mode', () => ({
  isOnPrem: vi.fn().mockReturnValue(false),
}));
vi.mock('../../observability/clickhouse-client', () => ({
  isClickHouseEnabled: mockIsClickHouseEnabled,
}));
vi.mock('../../observability/analytics-inserts', () => ({
  insertApiMetric: mockInsertApiMetric,
  insertSystemLog: mockInsertSystemLog,
  insertUserActivity: mockInsertUserActivity,
  insertError: mockInsertError,
}));

import {
  writeLogsToDatabase,
  writeApiMetrics,
  writeAiUsage,
  writeUserActivity,
  writeError,
} from '../logger-database';

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockReturnValue({ values: mockValues });
  mockValues.mockResolvedValue(undefined);
});

const makeLogEntry = () => ({
  timestamp: '2026-07-10T08:30:15.123Z',
  level: 'INFO',
  message: 'hello',
  hostname: 'h',
  pid: 1,
});

describe('given CLICKHOUSE_ENABLED off, writers should hit main PG and never the CH adapters', () => {
  beforeEach(() => {
    mockIsClickHouseEnabled.mockReturnValue(false);
  });

  it('writeLogsToDatabase → db.insert(systemLogs)', async () => {
    await writeLogsToDatabase([makeLogEntry()] as Parameters<typeof writeLogsToDatabase>[0]);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsertSystemLog).not.toHaveBeenCalled();
  });

  it('writeApiMetrics → db.insert(apiMetrics)', async () => {
    await writeApiMetrics({ endpoint: '/e', method: 'GET', statusCode: 200, duration: 1 });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsertApiMetric).not.toHaveBeenCalled();
  });

  it('writeUserActivity → db.insert(userActivities)', async () => {
    await writeUserActivity({ userId: 'u-1', action: 'a' });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsertUserActivity).not.toHaveBeenCalled();
  });

  it('writeError → db.insert(errorLogs)', async () => {
    await writeError({ name: 'E', message: 'm' });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsertError).not.toHaveBeenCalled();
  });
});

describe('given CLICKHOUSE_ENABLED on, writers should route to the CH adapters and retire the PG write', () => {
  beforeEach(() => {
    mockIsClickHouseEnabled.mockReturnValue(true);
  });

  it('writeLogsToDatabase → insertSystemLog per converted entry, no db.insert', async () => {
    await writeLogsToDatabase([
      makeLogEntry(),
      { ...makeLogEntry(), message: 'second', level: 'WARN' },
    ] as Parameters<typeof writeLogsToDatabase>[0]);

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockInsertSystemLog).toHaveBeenCalledTimes(2);
    // Rows go through the same convertToDbFormat extraction as the PG path.
    expect(mockInsertSystemLog.mock.calls[0][0]).toMatchObject({
      level: 'info',
      message: 'hello',
      hostname: 'h',
    });
    expect(mockInsertSystemLog.mock.calls[1][0]).toMatchObject({
      level: 'warn',
      message: 'second',
    });
    expect(mockInsertSystemLog.mock.calls[0][0].timestamp).toBeInstanceOf(Date);
    expect(mockInsertSystemLog.mock.calls[0][0].id).toBeTruthy();
  });

  it('writeLogsToDatabase with an empty array stays a no-op', async () => {
    await writeLogsToDatabase([]);
    expect(mockInsertSystemLog).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('writeApiMetrics → insertApiMetric with the caller shape, no db.insert', async () => {
    const ts = new Date('2026-07-10T00:00:00.000Z');
    await writeApiMetrics({
      endpoint: '/api/x',
      method: 'GET',
      statusCode: 200,
      duration: 42,
      userId: 'u-1',
      timestamp: ts,
    });

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockInsertApiMetric).toHaveBeenCalledTimes(1);
    expect(mockInsertApiMetric.mock.calls[0][0]).toMatchObject({
      endpoint: '/api/x',
      method: 'GET',
      statusCode: 200,
      duration: 42,
      userId: 'u-1',
      timestamp: ts,
    });
  });

  it('writeUserActivity → insertUserActivity, no db.insert', async () => {
    await writeUserActivity({ userId: 'u-1', action: 'page_view', resource: 'page' });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockInsertUserActivity).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1', action: 'page_view', resource: 'page' }),
    );
  });

  it('writeError → insertError, no db.insert', async () => {
    await writeError({ name: 'TypeError', message: 'bad', line: 42 });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockInsertError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'TypeError', message: 'bad', line: 42 }),
    );
  });

  it('writeAiUsage stays on main PG even when CH is on (Phase 4 CDC, not this leaf)', async () => {
    await writeAiUsage({ userId: 'u-1', provider: 'openrouter', model: 'm' });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsertApiMetric).not.toHaveBeenCalled();
    expect(mockInsertSystemLog).not.toHaveBeenCalled();
    expect(mockInsertUserActivity).not.toHaveBeenCalled();
    expect(mockInsertError).not.toHaveBeenCalled();
  });
});
