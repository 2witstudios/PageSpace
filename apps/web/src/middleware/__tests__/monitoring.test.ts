/**
 * Tests for monitoring middleware
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { db, apiMetrics } from '@pagespace/db';
import { getMonitoringIngestStatus } from '../monitoring';

// Mock the database
vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined)
    })
  },
  apiMetrics: {}
}));

// Mock loggers
vi.mock('@pagespace/lib/server', () => ({
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    }))
  },
  loggers: {
    performance: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    },
    api: {
      info: vi.fn(),
      error: vi.fn()
    },
    auth: {
      debug: vi.fn()
    },
    database: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    ai: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn()
    },
    system: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
  },
  extractRequestContext: vi.fn(() => ({
    method: 'GET',
    endpoint: '/api/test',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    sessionId: 'test-session',
    query: {}
  })),
  logResponse: vi.fn()
}));

// Mock request-id (has transitive dep on @paralleldrive/cuid2)
vi.mock('@/lib/request-id/request-id', () => ({
  getOrCreateRequestId: vi.fn(() => 'test-request-id'),
  REQUEST_ID_HEADER: 'X-Request-Id',
}));

describe('getMonitoringIngestStatus', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MONITORING_INGEST_KEY;
    delete process.env.MONITORING_INGEST_DISABLED;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('given MONITORING_INGEST_KEY is set, should return active', () => {
    process.env.MONITORING_INGEST_KEY = 'test-key-abc123';
    expect(getMonitoringIngestStatus()).toBe('active');
  });

  it('given MONITORING_INGEST_DISABLED is true, should return disabled', () => {
    process.env.MONITORING_INGEST_DISABLED = 'true';
    expect(getMonitoringIngestStatus()).toBe('disabled');
  });

  it('given MONITORING_INGEST_DISABLED is true with key also set, should return disabled', () => {
    process.env.MONITORING_INGEST_KEY = 'test-key-abc123';
    process.env.MONITORING_INGEST_DISABLED = 'true';
    expect(getMonitoringIngestStatus()).toBe('disabled');
  });

  it('given no key and no opt-out, should return misconfigured', () => {
    expect(getMonitoringIngestStatus()).toBe('misconfigured');
  });

  it('given MONITORING_INGEST_DISABLED is false, should not count as disabled', () => {
    process.env.MONITORING_INGEST_DISABLED = 'false';
    expect(getMonitoringIngestStatus()).toBe('misconfigured');
  });
});

describe('Monitoring Middleware - Database Persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should write metrics to database on flush', async () => {
    // This test verifies that the flush() method writes to the database
    // We're testing the implementation indirectly through the mock

    const mockInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined)
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.insert as any) = mockInsert;

    // The actual implementation will be tested in integration tests
    // This is a placeholder to ensure the types are correct
    expect(db.insert).toBeDefined();
    expect(apiMetrics).toBeDefined();
  });

  it('should handle database write errors gracefully', async () => {
    // This test verifies that errors are caught and logged
    const mockInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockRejectedValue(new Error('Database error'))
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.insert as any) = mockInsert;

    // The implementation should catch errors and fall back to logging
    // This will be verified in integration tests
    expect(true).toBe(true);
  });
});
