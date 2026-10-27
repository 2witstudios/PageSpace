import { describe, it, expect } from 'vitest';
import {
  toClickHouseDateTime64,
  mapApiMetricToRow,
  mapSystemLogToRow,
  mapUserActivityToRow,
  mapErrorLogToRow,
} from '../analytics-rows';

const assigned = {
  id: 'row-id-1',
  timestamp: new Date('2026-07-10T08:30:15.123Z'),
};
const CH_TS = '2026-07-10 08:30:15.123';

describe('toClickHouseDateTime64', () => {
  it('given a Date, should format as UTC YYYY-MM-DD HH:mm:ss.SSS for DateTime64(3) basic parsing', () => {
    expect(toClickHouseDateTime64(new Date('2026-07-10T08:30:15.123Z'))).toBe(CH_TS);
  });

  it('given a midnight boundary, should keep zero-padded fields', () => {
    expect(toClickHouseDateTime64(new Date('2026-01-02T00:00:00.000Z'))).toBe('2026-01-02 00:00:00.000');
  });
});

describe('mapApiMetricToRow — PG write shape → CH row', () => {
  it('given required fields only, should map them and null every optional column', () => {
    const row = mapApiMetricToRow(
      { endpoint: '/api/x', method: 'GET', statusCode: 200, duration: 42 },
      assigned,
    );
    expect(row).toEqual({
      id: 'row-id-1',
      timestamp: CH_TS,
      endpoint: '/api/x',
      method: 'GET',
      status_code: 200,
      duration: 42,
      request_size: null,
      response_size: null,
      user_id: null,
      session_id: null,
      ip: null,
      user_agent: null,
      error: null,
      request_id: null,
      cache_hit: null,
      cache_key: null,
    });
  });

  it('given all optional fields, should map camelCase → snake_case faithfully', () => {
    const row = mapApiMetricToRow(
      {
        endpoint: '/api/y',
        method: 'POST',
        statusCode: 201,
        duration: 5,
        requestSize: 512,
        responseSize: 1024,
        userId: 'u-1',
        sessionId: 's-1',
        ip: '10.0.0.1',
        userAgent: 'UA/1.0',
        error: 'boom',
        requestId: 'r-1',
        cacheHit: true,
        cacheKey: 'k',
      },
      assigned,
    );
    expect(row.request_size).toBe(512);
    expect(row.response_size).toBe(1024);
    expect(row.user_id).toBe('u-1');
    expect(row.session_id).toBe('s-1');
    expect(row.cache_hit).toBe(true);
    expect(row.cache_key).toBe('k');
  });

  it('given cacheHit false, should keep false (not null)', () => {
    const row = mapApiMetricToRow(
      { endpoint: '/e', method: 'GET', statusCode: 200, duration: 1, cacheHit: false },
      assigned,
    );
    expect(row.cache_hit).toBe(false);
  });
});

describe('mapSystemLogToRow — PG write shape → CH row', () => {
  it('given required fields only, should null optionals and default category to empty string (ORDER BY key)', () => {
    const row = mapSystemLogToRow({ level: 'info', message: 'hello' }, assigned);
    expect(row).toEqual({
      id: 'row-id-1',
      timestamp: CH_TS,
      level: 'info',
      message: 'hello',
      category: '',
      user_id: null,
      session_id: null,
      request_id: null,
      drive_id: null,
      page_id: null,
      endpoint: null,
      method: null,
      ip: null,
      user_agent: null,
      error_name: null,
      error_message: null,
      error_stack: null,
      duration: null,
      memory_used: null,
      memory_total: null,
      metadata: null,
      hostname: null,
      pid: null,
      version: null,
    });
  });

  it('given full context, should map every column', () => {
    const row = mapSystemLogToRow(
      {
        level: 'error',
        message: 'failed',
        category: 'api',
        userId: 'u-1',
        sessionId: 's-1',
        requestId: 'r-1',
        driveId: 'd-1',
        pageId: 'p-1',
        endpoint: '/api/z',
        method: 'PUT',
        ip: '127.0.0.1',
        userAgent: 'UA',
        errorName: 'TypeError',
        errorMessage: 'bad',
        errorStack: 'stack',
        duration: 9,
        memoryUsed: 50,
        memoryTotal: 100,
        metadata: { a: 1 },
        hostname: 'h',
        pid: 1234,
        version: '1.0.0',
      },
      assigned,
    );
    expect(row.category).toBe('api');
    expect(row.user_id).toBe('u-1');
    expect(row.drive_id).toBe('d-1');
    expect(row.error_name).toBe('TypeError');
    expect(row.memory_used).toBe(50);
    expect(row.memory_total).toBe(100);
    expect(row.hostname).toBe('h');
    expect(row.pid).toBe(1234);
  });

  it('given jsonb-shaped metadata, should serialize to a JSON string (CH String column)', () => {
    const row = mapSystemLogToRow(
      { level: 'info', message: 'm', metadata: { key: 'val', n: 5 } },
      assigned,
    );
    expect(row.metadata).toBe(JSON.stringify({ key: 'val', n: 5 }));
  });
});

describe('mapUserActivityToRow — PG write shape → CH row', () => {
  it('given required fields only, should map user_id and action and null optionals', () => {
    const row = mapUserActivityToRow({ userId: 'u-1', action: 'page_view' }, assigned);
    expect(row).toEqual({
      id: 'row-id-1',
      timestamp: CH_TS,
      user_id: 'u-1',
      action: 'page_view',
      session_id: null,
      resource: null,
      resource_id: null,
      drive_id: null,
      page_id: null,
      metadata: null,
      ip: null,
      user_agent: null,
    });
  });

  it('given full fields, should map camelCase → snake_case and serialize metadata', () => {
    const row = mapUserActivityToRow(
      {
        userId: 'u-2',
        action: 'delete',
        resource: 'conversation',
        resourceId: 'c-1',
        driveId: 'd-1',
        pageId: 'p-1',
        sessionId: 's-1',
        ip: '10.0.0.2',
        userAgent: 'UA',
        metadata: { reason: 'user_initiated' },
      },
      assigned,
    );
    expect(row.resource).toBe('conversation');
    expect(row.resource_id).toBe('c-1');
    expect(row.metadata).toBe(JSON.stringify({ reason: 'user_initiated' }));
  });
});

describe('mapErrorLogToRow — PG write shape → CH row', () => {
  it('given required fields only, should map name/message and null optionals', () => {
    const row = mapErrorLogToRow({ name: 'Error', message: 'oops' }, assigned);
    expect(row).toEqual({
      id: 'row-id-1',
      timestamp: CH_TS,
      name: 'Error',
      message: 'oops',
      stack: null,
      user_id: null,
      session_id: null,
      request_id: null,
      endpoint: null,
      method: null,
      file: null,
      line: null,
      column: null,
      ip: null,
      user_agent: null,
      metadata: null,
    });
  });

  it('given location fields, should map file/line/column', () => {
    const row = mapErrorLogToRow(
      { name: 'E', message: 'm', file: 'server.ts', line: 42, column: 7 },
      assigned,
    );
    expect(row.file).toBe('server.ts');
    expect(row.line).toBe(42);
    expect(row.column).toBe(7);
  });
});
