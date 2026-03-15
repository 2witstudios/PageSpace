import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock drizzle-orm before any imports that use it
vi.mock('drizzle-orm', () => ({
  lt: vi.fn((col, val) => ({ operator: 'lt', column: col, value: val })),
}));

// Mock @pagespace/db
const mockReturning = vi.fn();

vi.mock('@pagespace/db', () => ({
  db: {
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: mockReturning,
      })),
    })),
  },
  apiMetrics: { id: 'id', timestamp: 'timestamp' },
  systemLogs: { id: 'id', timestamp: 'timestamp' },
  securityAuditLog: { id: 'id', timestamp: 'timestamp' },
}));

import {
  getRetentionConfig,
  getRetentionCutoff,
  cleanupApiMetrics,
  cleanupSystemLogs,
  cleanupSecurityAuditLog,
  runMonitoringRetentionCleanup,
} from './monitoring-retention';
import { db } from '@pagespace/db';

// Mock environment
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
  it('returns default retention periods when no env vars set', () => {
    const config = getRetentionConfig();
    expect(config.apiMetricsDays).toBe(90);
    expect(config.systemLogsDays).toBe(30);
    expect(config.securityAuditDays).toBe(365);
  });

  it('uses env vars when set', () => {
    process.env.RETENTION_API_METRICS_DAYS = '60';
    process.env.RETENTION_SYSTEM_LOGS_DAYS = '14';
    process.env.RETENTION_SECURITY_AUDIT_DAYS = '730';

    const config = getRetentionConfig();
    expect(config.apiMetricsDays).toBe(60);
    expect(config.systemLogsDays).toBe(14);
    expect(config.securityAuditDays).toBe(730);
  });

  it('falls back to defaults for invalid env vars', () => {
    process.env.RETENTION_API_METRICS_DAYS = 'not-a-number';
    process.env.RETENTION_SYSTEM_LOGS_DAYS = '-5';
    process.env.RETENTION_SECURITY_AUDIT_DAYS = '0';

    const config = getRetentionConfig();
    expect(config.apiMetricsDays).toBe(90);
    expect(config.systemLogsDays).toBe(30);
    expect(config.securityAuditDays).toBe(365);
  });
});

describe('getRetentionCutoff', () => {
  it('returns a date N days in the past', () => {
    const now = Date.now();
    const cutoff = getRetentionCutoff(30);
    const expectedMs = 30 * 24 * 60 * 60 * 1000;
    const diff = now - cutoff.getTime();
    // Allow 1 second tolerance
    expect(Math.abs(diff - expectedMs)).toBeLessThan(1000);
  });
});

describe('cleanupApiMetrics', () => {
  it('calls delete on api_metrics table', async () => {
    const result = await cleanupApiMetrics({ retentionDays: 90 });
    expect(result.table).toBe('api_metrics');
    expect(result.deleted).toBe(0);
    expect(db.delete).toHaveBeenCalledTimes(1);
  });

  it('returns count of deleted rows', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }, { id: '2' }]);
    const result = await cleanupApiMetrics({ retentionDays: 90 });
    expect(result.deleted).toBe(2);
  });
});

describe('cleanupSystemLogs', () => {
  it('calls delete on system_logs table', async () => {
    const result = await cleanupSystemLogs({ retentionDays: 30 });
    expect(result.table).toBe('system_logs');
    expect(result.deleted).toBe(0);
    expect(db.delete).toHaveBeenCalledTimes(1);
  });

  it('returns count of deleted rows', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }, { id: '2' }, { id: '3' }]);
    const result = await cleanupSystemLogs({ retentionDays: 30 });
    expect(result.deleted).toBe(3);
  });
});

describe('cleanupSecurityAuditLog', () => {
  it('calls delete on security_audit_log table', async () => {
    const result = await cleanupSecurityAuditLog({ retentionDays: 365 });
    expect(result.table).toBe('security_audit_log');
    expect(result.deleted).toBe(0);
    expect(db.delete).toHaveBeenCalledTimes(1);
  });

  it('returns count of deleted rows', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }]);
    const result = await cleanupSecurityAuditLog({ retentionDays: 365 });
    expect(result.deleted).toBe(1);
  });
});

describe('runMonitoringRetentionCleanup', () => {
  it('cleans up all three monitoring tables', async () => {
    const results = await runMonitoringRetentionCleanup();
    expect(results).toHaveLength(3);
    const tables = results.map(r => r.table).sort();
    expect(tables).toEqual(['api_metrics', 'security_audit_log', 'system_logs']);
  });

  it('uses default retention config', async () => {
    const results = await runMonitoringRetentionCleanup();
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result).toHaveProperty('table');
      expect(result).toHaveProperty('deleted');
      expect(typeof result.deleted).toBe('number');
    }
  });

  it('uses custom retention config from env vars', async () => {
    process.env.RETENTION_API_METRICS_DAYS = '45';
    process.env.RETENTION_SYSTEM_LOGS_DAYS = '7';
    process.env.RETENTION_SECURITY_AUDIT_DAYS = '180';

    const results = await runMonitoringRetentionCleanup();
    expect(results).toHaveLength(3);
  });
});
