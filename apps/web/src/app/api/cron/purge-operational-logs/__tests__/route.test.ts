/**
 * Contract tests for /api/cron/purge-operational-logs
 *
 * Verifies operational log retention purge:
 *   - deletes rows older than LOG_RETENTION_DAYS from system_logs, api_metrics, error_logs
 *   - NEVER touches security_audit_log (compliance requirement)
 *   - authenticates via the shared cron secret helper
 *   - returns { purged: { system_logs, api_metrics, error_logs } }
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface TableStub {
  readonly __name: string;
  readonly timestamp: { readonly __col: string };
  readonly id: { readonly __col: string };
}

const {
  mockDelete,
  mockAudit,
  mockLt,
  systemLogsTable,
  apiMetricsTable,
  errorLogsTable,
  securityAuditLogTable,
} = vi.hoisted(() => {
  const makeTable = (name: string): TableStub => ({
    __name: name,
    timestamp: { __col: `${name}.timestamp` },
    id: { __col: `${name}.id` },
  });
  return {
    mockDelete: vi.fn(),
    mockAudit: vi.fn(),
    mockLt: vi.fn(),
    systemLogsTable: makeTable('system_logs'),
    apiMetricsTable: makeTable('api_metrics'),
    errorLogsTable: makeTable('error_logs'),
    securityAuditLogTable: makeTable('security_audit_log'),
  };
});

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: { delete: mockDelete },
  systemLogs: systemLogsTable,
  apiMetrics: apiMetricsTable,
  errorLogs: errorLogsTable,
  securityAuditLog: securityAuditLogTable,
  lt: (col: unknown, val: unknown) => {
    mockLt(col, val);
    return { __lt: true, col, val };
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  audit: mockAudit,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

import { GET } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/cron/purge-operational-logs');
}

/**
 * Simulate `db.delete(table).where(cond).returning(sel)` by returning N rows
 * worth of fake id objects. Counts per table are driven by `counts`.
 */
function primeDeleteChain(counts: Record<string, number>) {
  mockDelete.mockImplementation((table: TableStub) => {
    const n = counts[table.__name] ?? 0;
    const rows = Array.from({ length: n }, (_, i) => ({ id: `${table.__name}-${i}` }));
    return {
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue(rows),
      })),
    };
  });
}

describe('/api/cron/purge-operational-logs', () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV };
    delete process.env.LOG_RETENTION_DAYS;
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
    primeDeleteChain({ system_logs: 5, api_metrics: 7, error_logs: 2 });
  });

  it('returns per-table purge counts in the documented shape', async () => {
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.purged).toEqual({
      system_logs: 5,
      api_metrics: 7,
      error_logs: 2,
    });
  });

  it('issues DELETEs against exactly the three operational tables', async () => {
    await GET(makeRequest());

    const deletedTables = mockDelete.mock.calls.map(([t]) => (t as TableStub).__name);
    expect(deletedTables).toHaveLength(3);
    expect(deletedTables).toEqual(
      expect.arrayContaining(['system_logs', 'api_metrics', 'error_logs'])
    );
  });

  it('never issues a DELETE against security_audit_log', async () => {
    await GET(makeRequest());

    const touched = mockDelete.mock.calls.map(([t]) => (t as TableStub).__name);
    expect(touched).not.toContain('security_audit_log');
  });

  it('defaults retention window to 30 days when LOG_RETENTION_DAYS is unset', async () => {
    const before = Date.now();
    await GET(makeRequest());
    const after = Date.now();

    expect(mockLt).toHaveBeenCalledTimes(3);
    for (const call of mockLt.mock.calls) {
      const cutoff = call[1] as Date;
      expect(cutoff).toBeInstanceOf(Date);
      const expectedMin = before - 30 * 24 * 60 * 60 * 1000;
      const expectedMax = after - 30 * 24 * 60 * 60 * 1000;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedMin - 5);
      expect(cutoff.getTime()).toBeLessThanOrEqual(expectedMax + 5);
    }
  });

  it('honours LOG_RETENTION_DAYS when set', async () => {
    process.env.LOG_RETENTION_DAYS = '7';
    const before = Date.now();
    await GET(makeRequest());
    const after = Date.now();

    for (const call of mockLt.mock.calls) {
      const cutoff = call[1] as Date;
      const expectedMin = before - 7 * 24 * 60 * 60 * 1000;
      const expectedMax = after - 7 * 24 * 60 * 60 * 1000;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedMin - 5);
      expect(cutoff.getTime()).toBeLessThanOrEqual(expectedMax + 5);
    }
  });

  it('falls back to default when LOG_RETENTION_DAYS is invalid', async () => {
    process.env.LOG_RETENTION_DAYS = 'not-a-number';
    const before = Date.now();
    await GET(makeRequest());
    const after = Date.now();

    for (const call of mockLt.mock.calls) {
      const cutoff = call[1] as Date;
      const expectedMin = before - 30 * 24 * 60 * 60 * 1000;
      const expectedMax = after - 30 * 24 * 60 * 60 * 1000;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedMin - 5);
      expect(cutoff.getTime()).toBeLessThanOrEqual(expectedMax + 5);
    }
  });

  it('rejects unauthorized requests and performs no DELETE', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('records an audit event with per-table counts on success', async () => {
    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'data.delete',
        userId: 'system',
        resourceType: 'cron_job',
        resourceId: 'purge_operational_logs',
        details: expect.objectContaining({
          system_logs: 5,
          api_metrics: 7,
          error_logs: 2,
        }),
      })
    );
  });

  it('returns 500 and does not audit when a delete throws', async () => {
    mockDelete.mockImplementation(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockRejectedValue(new Error('db down')),
      })),
    }));

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('source file does not reference security_audit_log in executable code', () => {
    const source = readFileSync(join(__dirname, '..', 'route.ts'), 'utf8');
    // Strip block comments and line comments so we only check executable code.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(stripped).not.toMatch(/securityAuditLog/);
    expect(stripped).not.toMatch(/security_audit_log/);
  });
});
