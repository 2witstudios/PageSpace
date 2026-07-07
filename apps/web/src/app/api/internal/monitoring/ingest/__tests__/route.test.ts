/**
 * Monitoring ingest route tests.
 *
 * This route is the Node-runtime persistence layer for the edge middleware's
 * fire-and-forget monitoring POSTs: it is the ONLY writer of apiMetrics rows
 * (the admin dashboard's monitoring-queries.ts reads that table), plus a
 * systemLogs row per request and an errorLogs row for failures. The
 * apiMetrics-insertion assertions here are the persistence-parity acceptance
 * criterion for the edge-safe middleware work: middleware itself never touches
 * @pagespace/db, so the dashboard only gets data if this route writes it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockWriteApiMetrics = vi.hoisted(() => vi.fn());
const mockWriteError = vi.hoisted(() => vi.fn());
const mockSystemLogsValues = vi.hoisted(() => vi.fn());
const mockDbInsert = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db/db', () => ({
  db: { insert: mockDbInsert },
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  systemLogs: { __table: 'system_logs' },
}));
vi.mock('@pagespace/lib/logging/logger-database', () => ({
  writeApiMetrics: mockWriteApiMetrics,
  writeError: mockWriteError,
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    system: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    api: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  },
}));
vi.mock('@pagespace/lib/auth/secure-compare', () => ({
  secureCompare: (a: string, b: string) => a === b,
}));

import { POST } from '../route';

const INGEST_KEY = 'test-ingest-key';

const buildRequest = (
  body: unknown,
  { key = INGEST_KEY }: { key?: string | null } = {}
): Request =>
  new Request('http://localhost/api/internal/monitoring/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'x-monitoring-ingest-key': key } : {}),
    },
    body: JSON.stringify(body),
  });

const apiRequestPayload = {
  type: 'api-request' as const,
  requestId: 'req-cuid-1',
  timestamp: '2026-07-07T12:00:00.000Z',
  method: 'post',
  endpoint: '/api/pages/xyz',
  statusCode: 201,
  duration: 42,
  requestSize: 128,
  responseSize: 256,
  userId: 'user-1',
  sessionId: 'sess-1',
  ip: '10.0.0.1',
  userAgent: 'test-agent',
};

describe('POST /api/internal/monitoring/ingest', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MONITORING_INGEST_KEY = INGEST_KEY;
    delete process.env.MONITORING_INGEST_DISABLED;
    mockWriteApiMetrics.mockResolvedValue(undefined);
    mockWriteError.mockResolvedValue(undefined);
    mockSystemLogsValues.mockResolvedValue(undefined);
    mockDbInsert.mockReturnValue({ values: mockSystemLogsValues });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('rejects a request without the ingest key', async () => {
    const response = await POST(buildRequest(apiRequestPayload, { key: null }));
    expect(response.status).toBe(401);
    expect(mockWriteApiMetrics).not.toHaveBeenCalled();
  });

  it('rejects a request with a wrong ingest key', async () => {
    const response = await POST(buildRequest(apiRequestPayload, { key: 'wrong' }));
    expect(response.status).toBe(401);
    expect(mockWriteApiMetrics).not.toHaveBeenCalled();
  });

  it('inserts an apiMetrics row for an api-request payload (dashboard persistence parity)', async () => {
    const response = await POST(buildRequest(apiRequestPayload));

    expect(response.status).toBe(200);
    expect(mockWriteApiMetrics).toHaveBeenCalledTimes(1);
    expect(mockWriteApiMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: '/api/pages/xyz',
        method: 'POST',
        statusCode: 201,
        duration: 42,
        requestSize: 128,
        responseSize: 256,
        userId: 'user-1',
        sessionId: 'sess-1',
        ip: '10.0.0.1',
        userAgent: 'test-agent',
        requestId: 'req-cuid-1',
        timestamp: new Date('2026-07-07T12:00:00.000Z'),
      })
    );
  });

  it('also writes a systemLogs row for the same payload', async () => {
    await POST(buildRequest(apiRequestPayload));

    expect(mockDbInsert).toHaveBeenCalledTimes(1);
    expect(mockSystemLogsValues).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        category: 'api',
        endpoint: '/api/pages/xyz',
        method: 'POST',
        requestId: 'req-cuid-1',
      })
    );
  });

  it('writes an errorLogs row when the payload carries an error', async () => {
    const response = await POST(
      buildRequest({
        ...apiRequestPayload,
        statusCode: 500,
        error: 'HTTP 500',
        errorName: 'HttpError',
      })
    );

    expect(response.status).toBe(200);
    expect(mockWriteError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'HttpError', message: 'HTTP 500' })
    );
    expect(mockWriteApiMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, error: 'HTTP 500' })
    );
  });

  it('rejects non api-request payload types', async () => {
    const response = await POST(buildRequest({ ...apiRequestPayload, type: 'page-view' }));
    expect(response.status).toBe(400);
    expect(mockWriteApiMetrics).not.toHaveBeenCalled();
  });

  it('sanitizes the endpoint before persisting (query strings never reach the table)', async () => {
    await POST(
      buildRequest({ ...apiRequestPayload, endpoint: '/api/search?q=secret%20term' })
    );
    expect(mockWriteApiMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: '/api/search' })
    );
  });

  it('returns 503 when the ingest key is not configured', async () => {
    delete process.env.MONITORING_INGEST_KEY;
    const response = await POST(buildRequest(apiRequestPayload));
    expect(response.status).toBe(503);
  });

  it('returns 404 when ingest is explicitly disabled', async () => {
    process.env.MONITORING_INGEST_DISABLED = 'true';
    const response = await POST(buildRequest(apiRequestPayload));
    expect(response.status).toBe(404);
  });
});
