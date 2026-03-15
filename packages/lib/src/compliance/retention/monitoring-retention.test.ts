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
  securityAuditLog: { id: 'securityAuditLog.id', timestamp: 'securityAuditLog.timestamp' },
}));

import {
  getRetentionConfig,
  getRetentionCutoff,
  cleanupApiMetrics,
  cleanupSystemLogs,
  cleanupSecurityAuditLog,
  runMonitoringRetentionCleanup,
} from './monitoring-retention';
import { apiMetrics, systemLogs, securityAuditLog } from '@pagespace/db';

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.RETENTION_API_METRICS_DAYS;
  delete process.env.RETENTION_SYSTEM_LOGS_DAYS;
  delete process.env.RETENTION_SECURITY_AUDIT_DAYS;
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
      securityAuditDays: 365,
    });
  });

  it('given_validEnvVars_usesCustomValues', () => {
    process.env.RETENTION_API_METRICS_DAYS = '60';
    process.env.RETENTION_SYSTEM_LOGS_DAYS = '14';
    process.env.RETENTION_SECURITY_AUDIT_DAYS = '730';

    const config = getRetentionConfig();

    expect(config).toEqual({
      apiMetricsDays: 60,
      systemLogsDays: 14,
      securityAuditDays: 730,
    });
  });

  it('given_invalidEnvVars_fallsBackToDefaults', () => {
    process.env.RETENTION_API_METRICS_DAYS = 'not-a-number';
    process.env.RETENTION_SYSTEM_LOGS_DAYS = '-5';
    process.env.RETENTION_SECURITY_AUDIT_DAYS = '0';

    const config = getRetentionConfig();

    expect(config).toEqual({
      apiMetricsDays: 90,
      systemLogsDays: 30,
      securityAuditDays: 365,
    });
  });

  it('given_emptyStringEnvVars_fallsBackToDefaults', () => {
    process.env.RETENTION_API_METRICS_DAYS = '';

    const config = getRetentionConfig();

    expect(config.apiMetricsDays).toBe(90);
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

describe('cleanupSecurityAuditLog', () => {
  it('given_noExpiredRows_returnsZeroDeleted', async () => {
    const result = await cleanupSecurityAuditLog({ retentionDays: 365 });

    expect(result).toEqual({ table: 'security_audit_log', deleted: 0 });
    expect(mockDeleteTable).toHaveBeenCalledWith(securityAuditLog);
  });

  it('given_expiredRows_returnsDeletedCount', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }]);

    const result = await cleanupSecurityAuditLog({ retentionDays: 365 });

    expect(result).toEqual({ table: 'security_audit_log', deleted: 1 });
  });
});

describe('runMonitoringRetentionCleanup', () => {
  it('given_defaultConfig_cleansUpAllThreeTables', async () => {
    const results = await runMonitoringRetentionCleanup();
    const tables = results.map(r => r.table).sort();

    expect(tables).toEqual(['api_metrics', 'security_audit_log', 'system_logs']);
  });

  it('given_customEnvConfig_stillCleansAllThreeTables', async () => {
    process.env.RETENTION_API_METRICS_DAYS = '45';
    process.env.RETENTION_SYSTEM_LOGS_DAYS = '7';
    process.env.RETENTION_SECURITY_AUDIT_DAYS = '180';

    const results = await runMonitoringRetentionCleanup();

    expect(results).toHaveLength(3);
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
