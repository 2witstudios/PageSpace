/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';

// ============================================================================
// Contract Tests for /api/internal/monitoring/ingest
//
// Tests monitoring data ingestion endpoint with ingest-key auth.
// ============================================================================

const { mockInsertValues, mockInsert, mockWriteApiMetrics, mockWriteError } = vi.hoisted(() => ({
  mockInsertValues: vi.fn().mockResolvedValue(undefined),
  mockInsert: vi.fn(),
  mockWriteApiMetrics: vi.fn(),
  mockWriteError: vi.fn(),
}));

// The route imports from @pagespace/lib/logger-database which needs a Vite alias.
// We mock it at the resolved path that vitest can find (the package's logging module).
vi.mock('@pagespace/lib/logger-database', () => ({
  writeApiMetrics: mockWriteApiMetrics,
  writeError: mockWriteError,
}));

vi.mock('@pagespace/db', () => ({
  db: {
    insert: mockInsert,
  },
  systemLogs: {
    $inferInsert: {},
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    system: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib', () => ({
  secureCompare: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-cuid'),
}));

vi.mock('@/lib/monitoring/ingest-sanitizer', () => ({
  sanitizeIngestPayload: vi.fn((payload: any) => payload),
}));

import { POST } from '../route';
import { secureCompare } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/server';

// ============================================================================
// Helpers
// ============================================================================

const VALID_PAYLOAD = {
  type: 'api-request' as const,
  method: 'GET',
  endpoint: '/api/pages',
  statusCode: 200,
  duration: 150,
  requestSize: 0,
  responseSize: 1024,
  userId: 'user_123',
};

const makeRequest = (body: any, ingestKey?: string) => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (ingestKey) {
    headers['x-monitoring-ingest-key'] = ingestKey;
  }
  return new Request('http://localhost/api/internal/monitoring/ingest', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
};

// ============================================================================
// POST /api/internal/monitoring/ingest - Contract Tests
// ============================================================================

describe('POST /api/internal/monitoring/ingest', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      MONITORING_INGEST_KEY: 'test-ingest-key',
      MONITORING_INGEST_DISABLED: undefined,
    };
    vi.mocked(secureCompare).mockReturnValue(true);
    mockWriteApiMetrics.mockResolvedValue(undefined);
    mockWriteError.mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('disabled state', () => {
    it('should return 404 when monitoring ingest is explicitly disabled', async () => {
      process.env.MONITORING_INGEST_DISABLED = 'true';

      const request = makeRequest(VALID_PAYLOAD, 'test-ingest-key');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Monitoring ingest explicitly disabled');
    });
  });

  describe('configuration', () => {
    it('should return 503 when MONITORING_INGEST_KEY is not configured', async () => {
      delete process.env.MONITORING_INGEST_KEY;

      const request = makeRequest(VALID_PAYLOAD, 'any-key');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.error).toBe('Monitoring ingest not configured');
    });

    it('should log a warning when ingest key is not configured', async () => {
      delete process.env.MONITORING_INGEST_KEY;

      const request = makeRequest(VALID_PAYLOAD, 'any-key');
      await POST(request);

      expect(loggers.system.warn).toHaveBeenCalled();
    });
  });

  describe('authentication', () => {
    it('should return 401 when no ingest key header is provided', async () => {
      const request = new Request('http://localhost/api/internal/monitoring/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_PAYLOAD),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 401 when ingest key does not match', async () => {
      vi.mocked(secureCompare).mockReturnValue(false);

      const request = makeRequest(VALID_PAYLOAD, 'wrong-key');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('validation', () => {
    it('should return 400 for invalid JSON', async () => {
      const request = new Request('http://localhost/api/internal/monitoring/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-monitoring-ingest-key': 'test-ingest-key',
        },
        body: 'not-json',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid JSON payload');
    });

    it('should return 400 for unsupported payload type', async () => {
      const request = makeRequest({ ...VALID_PAYLOAD, type: 'unknown-type' }, 'test-ingest-key');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Unsupported payload type');
    });
  });

  describe('success - basic api-request', () => {
    it('should process api-request payload and return success', async () => {
      const request = makeRequest(VALID_PAYLOAD, 'test-ingest-key');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should call writeApiMetrics with payload data', async () => {
      const request = makeRequest(VALID_PAYLOAD, 'test-ingest-key');
      await POST(request);

      expect(mockWriteApiMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: '/api/pages',
          method: 'GET',
          statusCode: 200,
          duration: 150,
        })
      );
    });

    it('should insert into systemLogs', async () => {
      const request = makeRequest(VALID_PAYLOAD, 'test-ingest-key');
      await POST(request);

      expect(mockInsert).toHaveBeenCalled();
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mock-cuid',
          level: 'info',
          category: 'api',
          endpoint: '/api/pages',
          method: 'GET',
        })
      );
    });
  });

  describe('log level determination', () => {
    it('should use "info" level for 2xx status codes', async () => {
      const request = makeRequest({ ...VALID_PAYLOAD, statusCode: 200 }, 'test-ingest-key');
      await POST(request);

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'info' })
      );
    });

    it('should use "warn" level for 4xx status codes', async () => {
      const request = makeRequest({ ...VALID_PAYLOAD, statusCode: 404 }, 'test-ingest-key');
      await POST(request);

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn' })
      );
    });

    it('should use "error" level for 5xx status codes', async () => {
      const request = makeRequest({ ...VALID_PAYLOAD, statusCode: 500 }, 'test-ingest-key');
      await POST(request);

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'error' })
      );
    });
  });

  describe('error payloads', () => {
    it('should call writeError when payload contains error', async () => {
      const errorPayload = {
        ...VALID_PAYLOAD,
        statusCode: 500,
        error: 'Something went wrong',
        errorName: 'InternalError',
        errorStack: 'Error: Something went wrong\n    at handler...',
      };

      const request = makeRequest(errorPayload, 'test-ingest-key');
      await POST(request);

      expect(mockWriteError).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'InternalError',
          message: 'Something went wrong',
          stack: 'Error: Something went wrong\n    at handler...',
        })
      );
    });

    it('should not call writeError when payload has no error', async () => {
      const request = makeRequest(VALID_PAYLOAD, 'test-ingest-key');
      await POST(request);

      expect(mockWriteError).not.toHaveBeenCalled();
    });

    it('should use "RequestError" as default error name when errorName not provided', async () => {
      const errorPayload = {
        ...VALID_PAYLOAD,
        statusCode: 500,
        error: 'Unknown failure',
      };

      const request = makeRequest(errorPayload, 'test-ingest-key');
      await POST(request);

      expect(mockWriteError).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'RequestError' })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when writeApiMetrics throws', async () => {
      mockWriteApiMetrics.mockRejectedValue(new Error('Write failed'));

      const request = makeRequest(VALID_PAYLOAD, 'test-ingest-key');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to store monitoring data');
    });

    it('should log error details when storage fails', async () => {
      mockWriteApiMetrics.mockRejectedValue(new Error('Write failed'));

      const request = makeRequest(VALID_PAYLOAD, 'test-ingest-key');
      await POST(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Failed to ingest monitoring payload',
        expect.any(Error),
        expect.objectContaining({
          endpoint: '/api/pages',
          statusCode: 200,
        })
      );
    });
  });
});
