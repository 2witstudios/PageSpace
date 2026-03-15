import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReturning = vi.fn();
const mockWhere = vi.fn(() => ({ returning: mockReturning }));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ operator: 'and', conditions: args })),
  lt: vi.fn((col, val) => ({ operator: 'lt', column: col, value: val })),
  eq: vi.fn((col, val) => ({ operator: 'eq', column: col, value: val })),
  isNotNull: vi.fn((col) => ({ operator: 'isNotNull', column: col })),
}));

vi.mock('@pagespace/db', () => ({
  sessions: { id: 'sessions.id', expiresAt: 'sessions.expiresAt' },
  verificationTokens: { id: 'vt.id', expiresAt: 'vt.expiresAt' },
  socketTokens: { id: 'st.id', expiresAt: 'st.expiresAt' },
  emailUnsubscribeTokens: { id: 'eut.id', expiresAt: 'eut.expiresAt' },
  pulseSummaries: { id: 'ps.id', expiresAt: 'ps.expiresAt' },
  pageVersions: { id: 'pv.id', expiresAt: 'pv.expiresAt', isPinned: 'pv.isPinned' },
  driveBackups: { id: 'db.id', expiresAt: 'db.expiresAt', isPinned: 'db.isPinned' },
  pagePermissions: { id: 'pp.id', expiresAt: 'pp.expiresAt' },
  aiUsageLogs: { id: 'aul.id', expiresAt: 'aul.expiresAt' },
}));

vi.mock('./monitoring-retention', () => ({
  runMonitoringRetentionCleanup: vi.fn().mockResolvedValue([
    { table: 'api_metrics', deleted: 0 },
    { table: 'system_logs', deleted: 0 },
    { table: 'security_audit_log', deleted: 0 },
  ]),
}));

import {
  cleanupExpiredSessions,
  cleanupExpiredVerificationTokens,
  cleanupExpiredSocketTokens,
  cleanupExpiredEmailUnsubscribeTokens,
  cleanupExpiredPulseSummaries,
  cleanupExpiredPageVersions,
  cleanupExpiredDriveBackups,
  cleanupExpiredPagePermissions,
  cleanupExpiredAiUsageLogs,
  runRetentionCleanup,
} from './retention-engine';

function createMockDb() {
  return {
    delete: vi.fn(() => ({
      where: mockWhere,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReturning.mockResolvedValue([]);
});

describe('cleanupExpiredSessions', () => {
  it('should delete expired sessions and return result', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }, { id: '2' }]);
    const db = createMockDb();
    const result = await cleanupExpiredSessions(db as never);
    expect(result.table).toBe('sessions');
    expect(result.deleted).toBe(2);
    expect(db.delete).toHaveBeenCalledTimes(1);
  });

  it('should return 0 when no expired sessions', async () => {
    const db = createMockDb();
    const result = await cleanupExpiredSessions(db as never);
    expect(result.deleted).toBe(0);
  });
});

describe('cleanupExpiredVerificationTokens', () => {
  it('should delete expired verification tokens', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }]);
    const db = createMockDb();
    const result = await cleanupExpiredVerificationTokens(db as never);
    expect(result.table).toBe('verification_tokens');
    expect(result.deleted).toBe(1);
  });
});

describe('cleanupExpiredSocketTokens', () => {
  it('should delete expired socket tokens', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }]);
    const db = createMockDb();
    const result = await cleanupExpiredSocketTokens(db as never);
    expect(result.table).toBe('socket_tokens');
    expect(result.deleted).toBe(1);
  });
});

describe('cleanupExpiredEmailUnsubscribeTokens', () => {
  it('should delete expired email unsubscribe tokens', async () => {
    const db = createMockDb();
    const result = await cleanupExpiredEmailUnsubscribeTokens(db as never);
    expect(result.table).toBe('email_unsubscribe_tokens');
    expect(result.deleted).toBe(0);
  });
});

describe('cleanupExpiredPulseSummaries', () => {
  it('should delete expired pulse summaries', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }, { id: '2' }, { id: '3' }]);
    const db = createMockDb();
    const result = await cleanupExpiredPulseSummaries(db as never);
    expect(result.table).toBe('pulse_summaries');
    expect(result.deleted).toBe(3);
  });
});

describe('cleanupExpiredPageVersions', () => {
  it('should only delete unpinned expired page versions', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }]);
    const db = createMockDb();
    const result = await cleanupExpiredPageVersions(db as never);
    expect(result.table).toBe('page_versions');
    expect(result.deleted).toBe(1);
  });
});

describe('cleanupExpiredDriveBackups', () => {
  it('should only delete unpinned expired drive backups', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }]);
    const db = createMockDb();
    const result = await cleanupExpiredDriveBackups(db as never);
    expect(result.table).toBe('drive_backups');
    expect(result.deleted).toBe(1);
  });
});

describe('cleanupExpiredPagePermissions', () => {
  it('should delete permissions with expiresAt < now', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }]);
    const db = createMockDb();
    const result = await cleanupExpiredPagePermissions(db as never);
    expect(result.table).toBe('page_permissions');
    expect(result.deleted).toBe(1);
  });
});

describe('cleanupExpiredAiUsageLogs', () => {
  it('should delete AI usage logs with expiresAt < now', async () => {
    mockReturning.mockResolvedValueOnce([{ id: '1' }, { id: '2' }]);
    const db = createMockDb();
    const result = await cleanupExpiredAiUsageLogs(db as never);
    expect(result.table).toBe('ai_usage_logs');
    expect(result.deleted).toBe(2);
  });
});

describe('runRetentionCleanup', () => {
  it('should return results for all 12 tables', async () => {
    const db = createMockDb();
    const results = await runRetentionCleanup(db as never);
    expect(results).toHaveLength(12);
  });

  it('should include all expected table names', async () => {
    const db = createMockDb();
    const results = await runRetentionCleanup(db as never);
    const tableNames = results.map(r => r.table).sort();
    expect(tableNames).toEqual([
      'ai_usage_logs',
      'api_metrics',
      'drive_backups',
      'email_unsubscribe_tokens',
      'page_permissions',
      'page_versions',
      'pulse_summaries',
      'security_audit_log',
      'sessions',
      'socket_tokens',
      'system_logs',
      'verification_tokens',
    ]);
  });

  it('should have valid result structure for all entries', async () => {
    const db = createMockDb();
    const results = await runRetentionCleanup(db as never);
    for (const result of results) {
      expect(result).toHaveProperty('table');
      expect(result).toHaveProperty('deleted');
      expect(typeof result.table).toBe('string');
      expect(typeof result.deleted).toBe('number');
    }
  });
});
