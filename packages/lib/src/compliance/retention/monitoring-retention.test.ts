/**
 * @scaffold — monitoring-retention uses a module-level `db` import with
 * no injected seam. The ORM delete chain mock and mockReturnValueOnce
 * ladders are structural necessities. Assertions verify the observable
 * return contract (table name + deleted count).
 *
 * REVIEW: refactor cleanup functions to accept `db` as a parameter so
 * tests can mock at the injection boundary without reproducing the chain.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('drizzle-orm', () => ({
  lt: (col: unknown, val: unknown) => ({ _op: 'lt', col, val }),
}));

const mockReturning = vi.fn();
const mockDeleteTable = vi.fn();

vi.mock('@pagespace/db', () => ({
  db: {
    delete: (table: unknown) => {
      mockDeleteTable(table);
      return {
        where: vi.fn(() => ({
          returning: mockReturning,
        })),
      };
    },
  },
  apiMetrics: { id: 'apiMetrics.id', timestamp: 'apiMetrics.timestamp' },
  systemLogs: { id: 'systemLogs.id', timestamp: 'systemLogs.timestamp' },
  errorLogs: { id: 'errorLogs.id', timestamp: 'errorLogs.timestamp' },
  userActivities: { id: 'userActivities.id', timestamp: 'userActivities.timestamp' },
}));

import {
  getRetentionConfig,
  getRetentionCutoff,
  cleanupApiMetrics,
  cleanupSystemLogs,
  cleanupErrorLogs,
  cleanupUserActivities,
  runMonitoringRetentionCleanup,
} from './monitoring-retention';
import { apiMetrics, systemLogs, errorLogs, userActivities } from '@pagespace/db';

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.RETENTION_API_METRICS_DAYS;
  delete process.env.RETENTION_SYSTEM_LOGS_DAYS;
  delete process.env.RETENTION_ERROR_LOGS_DAYS;
  delete process.env.RETENTION_USER_ACTIVITIES_DAYS;
  vi.clearAllMocks();
  mockReturning.mockResolvedValue([]);
});

afterEach(() => {
  process.env = originalEnv;
});

describe('getRetentionConfig', () => {
  it('given_noEnvVars_returnsDefaultRetentionPeriods', () => {
    const config = getRetentionConfig();

    expect(config).toEqual({
      apiMetricsDays: 90,
      systemLogsDays: 30,
      errorLogsDays: 90,
      userActivitiesDays: 180,
    });
  });

  it('given_validEnvVars_usesCustomValues', () => {
    process.env.RETENTION_API_METRICS_DAYS = '60';
    process.env.RETENTION_SYSTEM_LOGS_DAYS = '14';
    process.env.RETENTION_ERROR_LOGS_DAYS = '45';
    process.env.RETENTION_USER_ACTIVITIES_DAYS = '90';

    const config = getRetentionConfig();

    expect(config).toEqual({
      apiMetricsDays: 60,
      systemLogsDays: 14,
      errorLogsDays: 45,
      userActivitiesDays: 90,
    });
  });

  it('given_invalidEnvVars_fallsBackToDefaults', () => {
    process.env.RETENTION_API_METRICS_DAYS = 'not-a-number';
    process.env.RETENTION_SYSTEM_LOGS_DAYS = '-5';
    process.env.RETENTION_ERROR_LOGS_DAYS = '0';
    process.env.RETENTION_USER_ACTIVITIES_DAYS = 'oops';

    const config = getRetentionConfig();

    expect(config).toEqual({
      apiMetricsDays: 90,
      systemLogsDays: 30,
      errorLogsDays: 90,
      userActivitiesDays: 180,
    });
  });

  it('given_emptyStringEnvVars_fallsBackToDefaults', () => {
    process.env.RETENTION_API_METRICS_DAYS = '';
    process.env.RETENTION_ERROR_LOGS_DAYS = '';

    const config = getRetentionConfig();

    expect(config.apiMetricsDays).toBe(90);
    expect(config.errorLogsDays).toBe(90);
  });
});

describe('getRetentionCutoff', () => {
  it('given_dayCount_returnsDateThatManyDaysAgo', () => {
    const now = Date.now();
    const cutoff = getRetentionCutoff(30);
    const expectedMs = 30 * 24 * 60 * 60 * 1000;
    const diff = now - cutoff.getTime();

    expect(Math.abs(diff - expectedMs)).toBeLessThan(1000);
  });

  it('given_zeroDays_returnsApproximatelyNow', () => {
    const before = Date.now();
    const cutoff = getRetentionCutoff(0);
    const after = Date.now();

    // 0 days retention → cutoff is approximately now (within 50ms test execution window)
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after + 1);
  });
});

describe('cleanupApiMetrics', () => {
  it('given_noExpiredRows_returnsZeroDeleted', async () => {
    const result = await cleanupApiMetrics({ retentionDays: 90 });

    expect(result).toEqual({ table: 'api_metrics', deleted: 0 });
    expect(mockDeleteTable).toHaveBeenCalledWith(apiMetrics);
  });

  it('given_expiredRows_returnsDeletedCount', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }, { id: '2' }]);

    const result = await cleanupApiMetrics({ retentionDays: 90 });

    expect(result).toEqual({ table: 'api_metrics', deleted: 2 });
  });

  it('given_databaseError_propagates', async () => {
    mockReturning.mockRejectedValueOnce(new Error('connection lost'));

    await expect(cleanupApiMetrics({ retentionDays: 90 })).rejects.toThrow('connection lost');
  });
});

describe('cleanupSystemLogs', () => {
  it('given_noExpiredRows_returnsZeroDeleted', async () => {
    const result = await cleanupSystemLogs({ retentionDays: 30 });

    expect(result).toEqual({ table: 'system_logs', deleted: 0 });
    expect(mockDeleteTable).toHaveBeenCalledWith(systemLogs);
  });

  it('given_expiredRows_returnsDeletedCount', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }, { id: '2' }, { id: '3' }]);

    const result = await cleanupSystemLogs({ retentionDays: 30 });

    expect(result).toEqual({ table: 'system_logs', deleted: 3 });
  });
});

describe('cleanupErrorLogs', () => {
  it('given_noExpiredRows_returnsZeroDeleted', async () => {
    const result = await cleanupErrorLogs({ retentionDays: 90 });

    expect(result).toEqual({ table: 'error_logs', deleted: 0 });
    expect(mockDeleteTable).toHaveBeenCalledWith(errorLogs);
  });

  it('given_expiredRows_returnsDeletedCount', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }, { id: '2' }]);

    const result = await cleanupErrorLogs({ retentionDays: 90 });

    expect(result).toEqual({ table: 'error_logs', deleted: 2 });
  });

  it('given_databaseError_propagates', async () => {
    mockReturning.mockRejectedValueOnce(new Error('connection lost'));

    await expect(cleanupErrorLogs({ retentionDays: 90 })).rejects.toThrow('connection lost');
  });
});

describe('cleanupUserActivities', () => {
  it('given_noExpiredRows_returnsZeroDeleted', async () => {
    const result = await cleanupUserActivities({ retentionDays: 180 });

    expect(result).toEqual({ table: 'user_activities', deleted: 0 });
    expect(mockDeleteTable).toHaveBeenCalledWith(userActivities);
  });

  it('given_expiredRows_returnsDeletedCount', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }]);

    const result = await cleanupUserActivities({ retentionDays: 180 });

    expect(result).toEqual({ table: 'user_activities', deleted: 4 });
  });
});

describe('runMonitoringRetentionCleanup', () => {
  it('given_defaultConfig_cleansAllFourMonitoringTables', async () => {
    const results = await runMonitoringRetentionCleanup();
    const tables = results.map(r => r.table).sort();

    expect(tables).toEqual(['api_metrics', 'error_logs', 'system_logs', 'user_activities']);
  });

  it('given_customEnvConfig_stillCleansAllTables', async () => {
    process.env.RETENTION_API_METRICS_DAYS = '45';
    process.env.RETENTION_SYSTEM_LOGS_DAYS = '7';
    process.env.RETENTION_ERROR_LOGS_DAYS = '60';
    process.env.RETENTION_USER_ACTIVITIES_DAYS = '120';

    const results = await runMonitoringRetentionCleanup();

    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(typeof result.table).toBe('string');
      expect(typeof result.deleted).toBe('number');
    }
  });

  it('given_databaseError_rejectsWithOriginalError', async () => {
    mockReturning.mockRejectedValue(new Error('disk full'));

    await expect(runMonitoringRetentionCleanup()).rejects.toThrow('disk full');
  });
});
