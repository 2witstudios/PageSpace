import { describe, it, expect, vi } from 'vitest';
import {
  buildUserSystemLogsExportQuery,
  buildUserApiMetricsExportQuery,
  buildUserErrorLogsExportQuery,
  buildUserErasureDeletes,
  parseUserSystemLogExportRows,
  parseUserApiMetricExportRows,
  parseUserErrorLogExportRows,
  collectChUserSystemLogs,
  collectChUserApiMetrics,
  collectChUserErrorLogs,
  deleteChUserAnalytics,
} from '../analytics-gdpr';

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

describe('GDPR export query builders — subject rows by user_id (#890 Phase 3 leaf 4)', () => {
  it('given a userId, should bind it as a named param and never interpolate it', () => {
    const malicious = "u'; DROP TABLE system_logs; --";
    for (const built of [
      buildUserSystemLogsExportQuery(malicious),
      buildUserApiMetricsExportQuery(malicious),
      buildUserErrorLogsExportQuery(malicious),
    ]) {
      expect(built.query).not.toContain(malicious);
      expect(built.query).toContain('{userId: String}');
      expect(built.query_params).toEqual({ userId: malicious });
    }
  });

  it('given system_logs, should select exactly the Art 15 export columns (no ip/user_agent/stack telemetry)', () => {
    const sql = flat(buildUserSystemLogsExportQuery('u1').query);
    expect(sql).toContain('FROM system_logs');
    expect(sql).toContain('WHERE user_id = {userId: String}');
    for (const col of ['id', 'timestamp', 'level', 'message', 'category', 'endpoint', 'method', 'duration']) {
      expect(sql).toContain(col);
    }
    for (const excluded of ['ip', 'user_agent', 'error_stack', 'session_id', 'request_id', 'metadata']) {
      expect(sql).not.toContain(excluded);
    }
  });

  it('given api_metrics, should select exactly the Art 15 export columns', () => {
    const sql = flat(buildUserApiMetricsExportQuery('u1').query);
    expect(sql).toContain('FROM api_metrics');
    for (const col of ['status_code', 'request_size', 'response_size', 'duration', 'endpoint', 'method']) {
      expect(sql).toContain(col);
    }
    for (const excluded of ['ip', 'user_agent', 'session_id', 'request_id', 'cache_hit', 'cache_key', 'error']) {
      expect(sql).not.toContain(excluded);
    }
  });

  it('given error_logs, should select the Art 15 export columns (resolution state lives in PG, not CH)', () => {
    const sql = flat(buildUserErrorLogsExportQuery('u1').query);
    expect(sql).toContain('FROM error_logs');
    for (const col of ['name', 'message', 'file', 'line', '`column`']) {
      expect(sql).toContain(col);
    }
    for (const excluded of ['resolved', 'stack', 'ip', 'user_agent', 'metadata']) {
      expect(sql).not.toContain(excluded);
    }
  });
});

describe('GDPR export row parsers — JSONEachRow → PG-parity export shapes', () => {
  it('given system_logs rows, should convert timestamps to Date and category empty-string back to null', () => {
    const rows = parseUserSystemLogExportRows([
      {
        id: 'sl1',
        timestamp: '2026-07-09 10:00:00.000',
        level: 'info',
        message: 'hello',
        category: '',
        endpoint: '/api/x',
        method: 'GET',
        duration: 12,
      },
      {
        id: 'sl2',
        timestamp: '2026-07-09 11:00:00.000',
        level: 'warn',
        message: 'hi',
        category: 'auth',
        endpoint: null,
        method: null,
        duration: null,
      },
    ]);
    expect(rows[0].timestamp).toEqual(new Date('2026-07-09T10:00:00.000Z'));
    expect(rows[0].category).toBeNull();
    expect(rows[1].category).toBe('auth');
    expect(rows[1].duration).toBeNull();
  });

  it('given api_metrics rows, should map snake_case columns to the camelCase export shape', () => {
    const rows = parseUserApiMetricExportRows([
      {
        id: 'm1',
        timestamp: '2026-07-09 10:00:00.000',
        endpoint: '/api/x',
        method: 'POST',
        status_code: 201,
        duration: 45,
        request_size: 100,
        response_size: null,
      },
    ]);
    expect(rows[0]).toEqual({
      id: 'm1',
      timestamp: new Date('2026-07-09T10:00:00.000Z'),
      endpoint: '/api/x',
      method: 'POST',
      statusCode: 201,
      duration: 45,
      requestSize: 100,
      responseSize: null,
    });
  });

  it('given error_logs rows, should map columns without any resolution state', () => {
    const rows = parseUserErrorLogExportRows([
      {
        id: 'e1',
        timestamp: '2026-07-09 10:00:00.000',
        name: 'TypeError',
        message: 'boom',
        endpoint: null,
        method: null,
        file: 'a.ts',
        line: 3,
        column: 7,
      },
    ]);
    expect(rows[0]).toEqual({
      id: 'e1',
      timestamp: new Date('2026-07-09T10:00:00.000Z'),
      name: 'TypeError',
      message: 'boom',
      endpoint: null,
      method: null,
      file: 'a.ts',
      line: 3,
      column: 7,
    });
    expect('resolved' in rows[0]).toBe(false);
  });
});

describe('buildUserErasureDeletes — Art 17 erasure mutations', () => {
  it('given a userId, should build one lightweight DELETE per analytics table with a bound param', () => {
    const deletes = buildUserErasureDeletes('victim-1');
    expect(deletes).toHaveLength(4);
    const tables = deletes.map((d) => /DELETE FROM (\w+)/.exec(flat(d.query))?.[1]).sort();
    expect(tables).toEqual(['api_metrics', 'error_logs', 'system_logs', 'user_activities']);
    for (const d of deletes) {
      expect(flat(d.query)).toContain('WHERE user_id = {userId: String}');
      expect(d.query).not.toContain('victim-1');
      expect(d.query_params).toEqual({ userId: 'victim-1' });
    }
  });
});

describe('CH shells — export reads and erasure deletes', () => {
  const mockClient = (rows: unknown[] = []) => ({
    query: vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue(rows) }),
    command: vi.fn().mockResolvedValue(undefined),
  });

  it('given a client, collectCh* should query JSONEachRow and return parsed shapes', async () => {
    const client = mockClient([
      {
        id: 'sl1',
        timestamp: '2026-07-09 10:00:00.000',
        level: 'info',
        message: 'hello',
        category: '',
        endpoint: null,
        method: null,
        duration: null,
      },
    ]);
    const rows = await collectChUserSystemLogs(client as never, 'u1');
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'JSONEachRow', query_params: { userId: 'u1' } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('sl1');
  });

  it('given a read failure, collectCh* should PROPAGATE (an incomplete Art 15 export must fail, not silently omit)', async () => {
    const client = {
      query: vi.fn().mockRejectedValue(new Error('CH unreachable')),
      command: vi.fn(),
    };
    await expect(collectChUserApiMetrics(client as never, 'u1')).rejects.toThrow('CH unreachable');
    await expect(collectChUserErrorLogs(client as never, 'u1')).rejects.toThrow('CH unreachable');
  });

  it('given a client, deleteChUserAnalytics should run all 4 erasure deletes through command()', async () => {
    const client = mockClient();
    await deleteChUserAnalytics(client as never, 'victim-1');
    expect(client.command).toHaveBeenCalledTimes(4);
    for (const call of client.command.mock.calls) {
      const arg = call[0] as { query: string; query_params: Record<string, unknown> };
      expect(flat(arg.query)).toMatch(/^DELETE FROM (api_metrics|system_logs|user_activities|error_logs) WHERE user_id = \{userId: String\}$/);
      expect(arg.query_params).toEqual({ userId: 'victim-1' });
    }
  });

  it('given a delete failure, deleteChUserAnalytics should PROPAGATE (erasure is fail-closed)', async () => {
    const client = {
      query: vi.fn(),
      command: vi.fn().mockRejectedValue(new Error('mutation rejected')),
    };
    await expect(deleteChUserAnalytics(client as never, 'victim-1')).rejects.toThrow('mutation rejected');
  });
});
