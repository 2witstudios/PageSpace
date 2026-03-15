/**
 * Tests for packages/lib/src/logging/logger-database.ts
 *
 * Covers:
 * - writeLogsToDatabase: empty array, batch insert, error handling
 * - writeApiMetrics: success, error
 * - writeAiUsage: success, error, on-prem expiry
 * - writeUserActivity: success, error
 * - writeError: success, error
 * - convertToDbFormat: all fields mapped correctly, context extraction,
 *   error extraction, performance extraction
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock @pagespace/db ──────────────────────────────────────────────────────
const mockInsert = vi.hoisted(() => vi.fn());
const mockValues = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@pagespace/db', () => ({
  db: {
    insert: mockInsert,
  },
  systemLogs: { tableName: 'system_logs' },
  apiMetrics: { tableName: 'api_metrics' },
  aiUsageLogs: {
    tableName: 'ai_usage_logs',
    id: 'id',
    timestamp: 'timestamp',
    userId: 'userId',
    prompt: 'prompt',
    completion: 'completion',
  },
  errorLogs: { tableName: 'error_logs' },
  userActivities: { tableName: 'user_activities' },
  lt: vi.fn(),
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  isNotNull: vi.fn(),
}));

// ── Mock deployment-mode ────────────────────────────────────────────────────
vi.mock('../../deployment-mode', () => ({
  isOnPrem: vi.fn().mockReturnValue(false),
}));

import {
  writeLogsToDatabase,
  writeApiMetrics,
  writeAiUsage,
  writeUserActivity,
  writeError,
} from '../logger-database';
import { db } from '@pagespace/db';
import { isOnPrem } from '../../deployment-mode';

// Helper: build a minimal LogEntry
function makeLogEntry(overrides: Partial<{
  timestamp: string;
  level: string;
  message: string;
  hostname: string;
  pid: number;
  version: string;
  context: Record<string, unknown>;
  error: { name: string; message: string; stack?: string };
  performance: { duration: number; memory?: { used: number; total: number } };
  metadata: Record<string, unknown>;
}> = {}) {
  return {
    timestamp: new Date().toISOString(),
    level: 'INFO',
    message: 'test message',
    hostname: 'localhost',
    pid: 1234,
    ...overrides,
  };
}

describe('writeLogsToDatabase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockResolvedValue(undefined);
  });

  it('returns immediately when entries array is empty', async () => {
    await writeLogsToDatabase([]);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('calls db.insert with converted entries for a single entry', async () => {
    const entries = [makeLogEntry({ message: 'hello' })];
    await writeLogsToDatabase(entries as Parameters<typeof writeLogsToDatabase>[0]);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockValues).toHaveBeenCalledTimes(1);
    const inserted = mockValues.mock.calls[0][0] as Array<{ message: string }>;
    expect(inserted[0].message).toBe('hello');
  });

  it('calls db.insert with all entries in a batch', async () => {
    const entries = [
      makeLogEntry({ message: 'first' }),
      makeLogEntry({ message: 'second' }),
      makeLogEntry({ message: 'third' }),
    ];
    await writeLogsToDatabase(entries as Parameters<typeof writeLogsToDatabase>[0]);
    const inserted = mockValues.mock.calls[0][0] as Array<{ message: string }>;
    expect(inserted).toHaveLength(3);
    expect(inserted[1].message).toBe('second');
  });

  it('handles database error without throwing', async () => {
    mockValues.mockRejectedValueOnce(new Error('DB error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      writeLogsToDatabase([makeLogEntry()] as Parameters<typeof writeLogsToDatabase>[0])
    ).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Logger] Failed to write logs'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it('logs entry count on database error', async () => {
    mockValues.mockRejectedValueOnce(new Error('DB error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeLogsToDatabase([makeLogEntry(), makeLogEntry()] as Parameters<typeof writeLogsToDatabase>[0]);
    const allCalls = consoleSpy.mock.calls.flat().join(' ');
    expect(allCalls).toContain('2');
    consoleSpy.mockRestore();
  });
});

describe('writeLogsToDatabase — convertToDbFormat field mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockResolvedValue(undefined);
  });

  it('maps level to lowercase', async () => {
    const entry = makeLogEntry({ level: 'WARN' });
    await writeLogsToDatabase([entry] as Parameters<typeof writeLogsToDatabase>[0]);
    const inserted = mockValues.mock.calls[0][0] as Array<{ level: string }>;
    expect(inserted[0].level).toBe('warn');
  });

  it('maps hostname, pid, version', async () => {
    const entry = makeLogEntry({ hostname: 'server1', pid: 9999, version: '1.0.0' });
    await writeLogsToDatabase([entry] as Parameters<typeof writeLogsToDatabase>[0]);
    const inserted = mockValues.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(inserted[0].hostname).toBe('server1');
    expect(inserted[0].pid).toBe(9999);
    expect(inserted[0].version).toBe('1.0.0');
  });

  it('converts timestamp string to Date object', async () => {
    const ts = '2024-06-15T10:00:00.000Z';
    const entry = makeLogEntry({ timestamp: ts });
    await writeLogsToDatabase([entry] as Parameters<typeof writeLogsToDatabase>[0]);
    const inserted = mockValues.mock.calls[0][0] as Array<{ timestamp: Date }>;
    expect(inserted[0].timestamp).toBeInstanceOf(Date);
    expect(inserted[0].timestamp.toISOString()).toBe(ts);
  });

  it('generates a unique id for each entry', async () => {
    const entries = [makeLogEntry(), makeLogEntry()];
    await writeLogsToDatabase(entries as Parameters<typeof writeLogsToDatabase>[0]);
    const inserted = mockValues.mock.calls[0][0] as Array<{ id: string }>;
    expect(inserted[0].id).toBeTruthy();
    expect(inserted[1].id).toBeTruthy();
    expect(inserted[0].id).not.toBe(inserted[1].id);
  });

  it('extracts context fields to top-level db entry fields', async () => {
    const entry = makeLogEntry({
      context: {
        userId: 'u-1',
        sessionId: 's-1',
        requestId: 'r-1',
        driveId: 'd-1',
        pageId: 'p-1',
        endpoint: '/api/test',
        method: 'GET',
        ip: '127.0.0.1',
        userAgent: 'TestAgent',
        category: 'auth',
      },
    });
    await writeLogsToDatabase([entry] as Parameters<typeof writeLogsToDatabase>[0]);
    const inserted = mockValues.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(inserted[0].userId).toBe('u-1');
    expect(inserted[0].sessionId).toBe('s-1');
    expect(inserted[0].requestId).toBe('r-1');
    expect(inserted[0].driveId).toBe('d-1');
    expect(inserted[0].pageId).toBe('p-1');
    expect(inserted[0].endpoint).toBe('/api/test');
    expect(inserted[0].method).toBe('GET');
    expect(inserted[0].ip).toBe('127.0.0.1');
    expect(inserted[0].userAgent).toBe('TestAgent');
    expect(inserted[0].category).toBe('auth');
  });

  it('preserves remaining context fields in metadata', async () => {
    const entry = makeLogEntry({
      context: {
        userId: 'u-1',
        customField: 'custom-value',
      },
    });
    await writeLogsToDatabase([entry] as Parameters<typeof writeLogsToDatabase>[0]);
    const inserted = mockValues.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(inserted[0].metadata).toMatchObject({ customField: 'custom-value' });
  });

  it('does not add metadata key when remaining context is empty', async () => {
    const entry = makeLogEntry({
      context: { userId: 'u-1' }, // only known fields, no remainingContext
    });
    await writeLogsToDatabase([entry] as Parameters<typeof writeLogsToDatabase>[0]);
    const inserted = mockValues.mock.calls[0][0] as Array<Record<string, unknown>>;
    // metadata should be undefined or absent (no extra context fields)
    expect(inserted[0].metadata).toBeUndefined();
  });

  it('extracts error name, message, stack', async () => {
    const entry = makeLogEntry({
      error: { name: 'TypeError', message: 'bad type', stack: 'TypeError: bad type\n  at ...' },
    });
    await writeLogsToDatabase([entry] as Parameters<typeof writeLogsToDatabase>[0]);
    const inserted = mockValues.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(inserted[0].errorName).toBe('TypeError');
    expect(inserted[0].errorMessage).toBe('bad type');
    expect(inserted[0].errorStack).toContain('TypeError');
  });

  it('extracts performance duration and memory', async () => {
    const entry = makeLogEntry({
      performance: { duration: 123, memory: { used: 50, total: 100 } },
    });
    await writeLogsToDatabase([entry] as Parameters<typeof writeLogsToDatabase>[0]);
    const inserted = mockValues.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(inserted[0].duration).toBe(123);
    expect(inserted[0].memoryUsed).toBe(50);
    expect(inserted[0].memoryTotal).toBe(100);
  });

  it('handles performance without memory', async () => {
    const entry = makeLogEntry({
      performance: { duration: 42 },
    });
    await writeLogsToDatabase([entry] as Parameters<typeof writeLogsToDatabase>[0]);
    const inserted = mockValues.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(inserted[0].duration).toBe(42);
    expect(inserted[0].memoryUsed).toBeUndefined();
    expect(inserted[0].memoryTotal).toBeUndefined();
  });

  it('merges entry.metadata into db metadata', async () => {
    const entry = makeLogEntry({
      metadata: { key: 'value', count: 5 },
    });
    await writeLogsToDatabase([entry] as Parameters<typeof writeLogsToDatabase>[0]);
    const inserted = mockValues.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(inserted[0].metadata).toMatchObject({ key: 'value', count: 5 });
  });

  it('merges both context remainder and entry.metadata', async () => {
    const entry = makeLogEntry({
      context: { userId: 'u-1', extra: 'ctx-extra' },
      metadata: { metaKey: 'meta-val' },
    });
    await writeLogsToDatabase([entry] as Parameters<typeof writeLogsToDatabase>[0]);
    const inserted = mockValues.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(inserted[0].metadata).toMatchObject({ extra: 'ctx-extra', metaKey: 'meta-val' });
  });
});

describe('writeApiMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockResolvedValue(undefined);
  });

  it('calls db.insert with provided fields', async () => {
    await writeApiMetrics({
      endpoint: '/api/test',
      method: 'GET',
      statusCode: 200,
      duration: 50,
      userId: 'u-1',
    });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const inserted = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.endpoint).toBe('/api/test');
    expect(inserted.method).toBe('GET');
    expect(inserted.statusCode).toBe(200);
    expect(inserted.duration).toBe(50);
    expect(inserted.userId).toBe('u-1');
  });

  it('uses provided timestamp when given', async () => {
    const ts = new Date('2024-01-01T00:00:00Z');
    await writeApiMetrics({
      endpoint: '/api/x',
      method: 'POST',
      statusCode: 201,
      duration: 100,
      timestamp: ts,
    });
    const inserted = mockValues.mock.calls[0][0] as { timestamp: Date };
    expect(inserted.timestamp).toBe(ts);
  });

  // REVIEW: Timestamp precision test — uses Date.now() before/after boundaries.
  // On a very slow CI, the spread could be larger than expected.
  it('defaults timestamp to now when not provided', async () => {
    const before = Date.now();
    await writeApiMetrics({
      endpoint: '/api/y',
      method: 'DELETE',
      statusCode: 204,
      duration: 20,
    });
    const after = Date.now();
    const inserted = mockValues.mock.calls[0][0] as { timestamp: Date };
    expect(inserted.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(inserted.timestamp.getTime()).toBeLessThanOrEqual(after);
  });

  it('handles optional fields', async () => {
    await writeApiMetrics({
      endpoint: '/api/z',
      method: 'PATCH',
      statusCode: 200,
      duration: 10,
      requestSize: 512,
      responseSize: 1024,
      sessionId: 's-1',
      ip: '10.0.0.1',
      userAgent: 'TestAgent',
      error: 'Timeout',
      requestId: 'r-1',
      cacheHit: true,
      cacheKey: 'cache:key',
    });
    const inserted = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.requestSize).toBe(512);
    expect(inserted.cacheHit).toBe(true);
    expect(inserted.cacheKey).toBe('cache:key');
  });

  it('handles database error without throwing', async () => {
    mockValues.mockRejectedValueOnce(new Error('metrics insert fail'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(writeApiMetrics({
      endpoint: '/api/fail',
      method: 'GET',
      statusCode: 500,
      duration: 1,
    })).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Logger] Failed to write API metrics'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });
});

describe('writeAiUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockResolvedValue(undefined);
    vi.mocked(isOnPrem).mockReturnValue(false);
    delete process.env.AI_LOG_RETENTION_DAYS;
  });

  afterEach(() => {
    delete process.env.AI_LOG_RETENTION_DAYS;
  });

  it('calls db.insert with required usage fields', async () => {
    await writeAiUsage({ userId: 'u-1', provider: 'openai', model: 'gpt-4' });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const inserted = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.userId).toBe('u-1');
    expect(inserted.provider).toBe('openai');
    expect(inserted.model).toBe('gpt-4');
  });

  it('includes optional token and cost fields', async () => {
    await writeAiUsage({
      userId: 'u-2',
      provider: 'anthropic',
      model: 'claude-3',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cost: 0.005,
      duration: 2000,
    });
    const inserted = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.inputTokens).toBe(100);
    expect(inserted.outputTokens).toBe(50);
    expect(inserted.totalTokens).toBe(150);
    expect(inserted.cost).toBe(0.005);
    expect(inserted.duration).toBe(2000);
  });

  it('includes context tracking fields', async () => {
    await writeAiUsage({
      userId: 'u-3',
      provider: 'google',
      model: 'gemini',
      contextMessages: ['msg1', 'msg2'],
      contextSize: 1000,
      systemPromptTokens: 200,
      toolDefinitionTokens: 50,
      conversationTokens: 750,
      messageCount: 5,
      wasTruncated: false,
      truncationStrategy: 'oldest_first',
    });
    const inserted = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.contextMessages).toEqual(['msg1', 'msg2']);
    expect(inserted.contextSize).toBe(1000);
    expect(inserted.messageCount).toBe(5);
    expect(inserted.wasTruncated).toBe(false);
    expect(inserted.truncationStrategy).toBe('oldest_first');
  });

  it('does not include expiresAt when not on-prem', async () => {
    vi.mocked(isOnPrem).mockReturnValue(false);
    await writeAiUsage({ userId: 'u-1', provider: 'openai', model: 'gpt-4' });
    const inserted = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.expiresAt).toBeUndefined();
  });

  it('includes expiresAt when on-prem (default 90 days)', async () => {
    vi.mocked(isOnPrem).mockReturnValue(true);
    const before = Date.now();
    await writeAiUsage({ userId: 'u-1', provider: 'openai', model: 'gpt-4' });
    const after = Date.now();
    const inserted = mockValues.mock.calls[0][0] as { expiresAt: Date };
    expect(inserted.expiresAt).toBeInstanceOf(Date);
    const expectedMs = 90 * 24 * 60 * 60 * 1000;
    expect(inserted.expiresAt.getTime()).toBeGreaterThanOrEqual(before + expectedMs);
    expect(inserted.expiresAt.getTime()).toBeLessThanOrEqual(after + expectedMs);
  });

  it('respects AI_LOG_RETENTION_DAYS env var when on-prem', async () => {
    vi.mocked(isOnPrem).mockReturnValue(true);
    process.env.AI_LOG_RETENTION_DAYS = '30';
    const before = Date.now();
    await writeAiUsage({ userId: 'u-1', provider: 'openai', model: 'gpt-4' });
    const after = Date.now();
    const inserted = mockValues.mock.calls[0][0] as { expiresAt: Date };
    const expectedMs = 30 * 24 * 60 * 60 * 1000;
    expect(inserted.expiresAt.getTime()).toBeGreaterThanOrEqual(before + expectedMs);
    expect(inserted.expiresAt.getTime()).toBeLessThanOrEqual(after + expectedMs);
  });

  it('falls back to 90 days when AI_LOG_RETENTION_DAYS is NaN', async () => {
    vi.mocked(isOnPrem).mockReturnValue(true);
    process.env.AI_LOG_RETENTION_DAYS = 'not-a-number';
    const before = Date.now();
    await writeAiUsage({ userId: 'u-1', provider: 'openai', model: 'gpt-4' });
    const after = Date.now();
    const inserted = mockValues.mock.calls[0][0] as { expiresAt: Date };
    const expectedMs = 90 * 24 * 60 * 60 * 1000;
    expect(inserted.expiresAt.getTime()).toBeGreaterThanOrEqual(before + expectedMs);
    expect(inserted.expiresAt.getTime()).toBeLessThanOrEqual(after + expectedMs);
  });

  it('handles database error without throwing', async () => {
    mockValues.mockRejectedValueOnce(new Error('ai usage insert fail'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      writeAiUsage({ userId: 'u-1', provider: 'openai', model: 'gpt-4' })
    ).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Logger] Failed to write AI usage'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });
});

describe('writeUserActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockResolvedValue(undefined);
  });

  it('calls db.insert with required activity fields', async () => {
    await writeUserActivity({ userId: 'u-1', action: 'page_view' });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const inserted = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.userId).toBe('u-1');
    expect(inserted.action).toBe('page_view');
  });

  it('includes optional fields when provided', async () => {
    await writeUserActivity({
      userId: 'u-2',
      action: 'edit',
      resource: 'page',
      resourceId: 'p-1',
      driveId: 'd-1',
      pageId: 'p-1',
      sessionId: 's-1',
      ip: '192.168.0.1',
      userAgent: 'Browser/1.0',
      metadata: { key: 'val' },
    });
    const inserted = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.resource).toBe('page');
    expect(inserted.resourceId).toBe('p-1');
    expect(inserted.driveId).toBe('d-1');
    expect(inserted.ip).toBe('192.168.0.1');
    expect(inserted.metadata).toEqual({ key: 'val' });
  });

  it('generates an id for each entry', async () => {
    await writeUserActivity({ userId: 'u-1', action: 'login' });
    const inserted = mockValues.mock.calls[0][0] as { id: string };
    expect(inserted.id).toBeTruthy();
  });

  it('handles database error without throwing', async () => {
    mockValues.mockRejectedValueOnce(new Error('activity insert fail'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      writeUserActivity({ userId: 'u-1', action: 'logout' })
    ).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Logger] Failed to write user activity'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });
});

describe('writeError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockResolvedValue(undefined);
  });

  it('calls db.insert with required error fields', async () => {
    await writeError({ name: 'TypeError', message: 'bad value' });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const inserted = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.name).toBe('TypeError');
    expect(inserted.message).toBe('bad value');
  });

  it('includes optional error context fields', async () => {
    await writeError({
      name: 'Error',
      message: 'something went wrong',
      stack: 'Error: something\n  at fn',
      userId: 'u-1',
      sessionId: 's-1',
      requestId: 'r-1',
      endpoint: '/api/fail',
      method: 'POST',
      file: 'server.ts',
      line: 42,
      column: 10,
      ip: '10.0.0.1',
      userAgent: 'Agent/1.0',
      metadata: { context: 'value' },
    });
    const inserted = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.stack).toContain('Error: something');
    expect(inserted.userId).toBe('u-1');
    expect(inserted.requestId).toBe('r-1');
    expect(inserted.endpoint).toBe('/api/fail');
    expect(inserted.method).toBe('POST');
    expect(inserted.file).toBe('server.ts');
    expect(inserted.line).toBe(42);
    expect(inserted.column).toBe(10);
  });

  it('generates an id', async () => {
    await writeError({ name: 'Error', message: 'test' });
    const inserted = mockValues.mock.calls[0][0] as { id: string };
    expect(inserted.id).toBeTruthy();
  });

  it('handles database error without throwing', async () => {
    mockValues.mockRejectedValueOnce(new Error('error insert fail'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      writeError({ name: 'Error', message: 'test' })
    ).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Logger] Failed to write error log'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });
});
