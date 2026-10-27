/**
 * Pure core of the ClickHouse analytics READ path (#890 Phase 3 leaf 3).
 *
 * These tests pin the logic that makes the CH reader output-compatible with
 * the old PG monitoring queries: UInt64-as-string coercion (JSONEachRow
 * quotes 64-bit ints), UTC DateTime parsing back to Date objects (matching
 * the node-postgres runtime shape), the system_logs.category ''→null
 * un-mapping (leaf 2 mapped PG NULL to '' because category is an ORDER BY
 * key), and query builders that bind every dynamic value as a named
 * parameter (never string-interpolated).
 */
import { describe, it, expect } from 'vitest';
import {
  chCount,
  chNullableNumber,
  chDateTime,
  emptyToNull,
  parseChMetadata,
  buildLogsByLevelQuery,
  buildRecentErrorsQuery,
  buildVolumeOverTimeQuery,
  buildTopEndpointsQuery,
  buildRequestErrorCountsQuery,
  buildErrorTrendsQuery,
  buildErrorPatternsQuery,
  buildFailedLoginsQuery,
  buildActivityHeatmapQuery,
  buildMostActiveUsersQuery,
  buildFeatureUsageQuery,
  buildActiveUserCountQuery,
  buildResponseTimesQuery,
  buildSlowQueriesQuery,
  buildEndpointPerformanceQuery,
  parseLogsByLevelRows,
  parseRecentErrorRows,
  parseVolumeOverTimeRows,
  parseTopEndpointRows,
  parseRequestErrorCounts,
  parseErrorTrendRows,
  parseErrorPatternRows,
  parseFailedLoginRows,
  parseActivityHeatmapRows,
  parseMostActiveUserRows,
  parseFeatureUsageRows,
  parseActiveUserCount,
  parseResponseTimeRows,
  parseSlowQueryRows,
  parseEndpointPerformanceRows,
} from '../analytics-read-core';

const WINDOW = {
  startDate: new Date('2021-03-05T10:00:00.000Z'),
  endDate: new Date('2021-03-05T11:00:00.000Z'),
};

describe('chCount', () => {
  it('given a UInt64 serialized as a string, should coerce to a number', () => {
    expect(chCount('42')).toBe(42);
  });

  it('given an already-numeric value, should pass it through', () => {
    expect(chCount(7)).toBe(7);
  });

  it('given null/undefined, should return 0', () => {
    expect(chCount(null)).toBe(0);
    expect(chCount(undefined)).toBe(0);
  });
});

describe('chNullableNumber', () => {
  it('given a float, should return it', () => {
    expect(chNullableNumber(12.5)).toBe(12.5);
  });

  it('given null (CH avg over empty set serializes nan as null), should return null', () => {
    expect(chNullableNumber(null)).toBeNull();
  });

  it('given a numeric string, should coerce', () => {
    expect(chNullableNumber('99')).toBe(99);
  });
});

describe('chDateTime', () => {
  it('given a DateTime64(3, UTC) string, should parse as UTC', () => {
    expect(chDateTime('2021-03-05 10:30:00.123').toISOString()).toBe(
      '2021-03-05T10:30:00.123Z',
    );
  });

  it('given a second-precision DateTime string (toStartOfHour output), should parse as UTC', () => {
    expect(chDateTime('2021-03-05 10:00:00').toISOString()).toBe(
      '2021-03-05T10:00:00.000Z',
    );
  });
});

describe('emptyToNull', () => {
  it("given '' (the CH stand-in for PG NULL category), should return null", () => {
    expect(emptyToNull('')).toBeNull();
  });

  it('given a real category, should pass it through', () => {
    expect(emptyToNull('auth')).toBe('auth');
  });

  it('given null (Nullable CH column), should return null', () => {
    expect(emptyToNull(null)).toBeNull();
  });
});

describe('parseChMetadata', () => {
  it('given a JSON-object string, should parse to the object', () => {
    expect(parseChMetadata('{"a":1}')).toEqual({ a: 1 });
  });

  it('given null, should return null', () => {
    expect(parseChMetadata(null)).toBeNull();
  });

  it('given malformed JSON, should return null rather than throw', () => {
    expect(parseChMetadata('{oops')).toBeNull();
  });

  it('given a JSON scalar (not an object), should return null to match the jsonb Record shape', () => {
    expect(parseChMetadata('42')).toBeNull();
  });
});

describe('query builders', () => {
  it('given a full window, should bind start and end as named params (never interpolate)', () => {
    const q = buildLogsByLevelQuery(WINDOW);
    expect(q.query).toContain('FROM system_logs');
    expect(q.query).toContain('{tw_start: DateTime64(3)}');
    expect(q.query).toContain('{tw_end: DateTime64(3)}');
    expect(q.query).not.toContain('2021-03-05');
    expect(q.query_params.tw_start).toBe('2021-03-05 10:00:00.000');
    expect(q.query_params.tw_end).toBe('2021-03-05 11:00:00.000');
  });

  it('given no window, should emit no window conditions', () => {
    const q = buildLogsByLevelQuery({});
    expect(q.query).not.toContain('tw_start');
    expect(q.query).not.toContain('tw_end');
    expect(q.query_params).toEqual({});
  });

  it('given recent-errors, should order desc by timestamp and bind the limit', () => {
    const q = buildRecentErrorsQuery(WINDOW, 20);
    expect(q.query).toContain('FROM error_logs');
    expect(q.query).toContain('ORDER BY timestamp DESC');
    expect(q.query).toContain('{limit: UInt32}');
    expect(q.query_params.limit).toBe(20);
  });

  it('given volume-over-time, should bucket by hour and cap at 168 buckets', () => {
    const q = buildVolumeOverTimeQuery(WINDOW);
    expect(q.query).toContain('FROM api_metrics');
    expect(q.query).toContain('toStartOfHour(timestamp)');
    expect(q.query_params.limit).toBe(168);
  });

  it('given top-endpoints, should group by endpoint, busiest first, top 10', () => {
    const q = buildTopEndpointsQuery(WINDOW);
    expect(q.query).toContain('GROUP BY endpoint');
    expect(q.query_params.limit).toBe(10);
  });

  it('given request/error counts, should count errors as status_code >= 400 in one pass', () => {
    const q = buildRequestErrorCountsQuery(WINDOW);
    expect(q.query).toContain('countIf(status_code >= 400)');
  });

  it('given error trends, should filter level=error and group hour+category', () => {
    const q = buildErrorTrendsQuery(WINDOW);
    expect(q.query).toContain("level = 'error'");
    expect(q.query).toContain('FROM system_logs');
  });

  it('given error patterns, should group by name+endpoint from error_logs', () => {
    const q = buildErrorPatternsQuery(WINDOW);
    expect(q.query).toContain('FROM error_logs');
    expect(q.query).toContain('GROUP BY name, endpoint');
  });

  it('given failed logins, should filter category=auth at warn/error', () => {
    const q = buildFailedLoginsQuery(WINDOW);
    expect(q.query).toContain("category = 'auth'");
    expect(q.query).toContain("level IN ('warn', 'error')");
  });

  it('given the heatmap, should convert CH day-of-week (1=Mon..7=Sun) to PG DOW (0=Sun..6=Sat) in SQL', () => {
    const q = buildActivityHeatmapQuery(WINDOW);
    expect(q.query).toContain('toDayOfWeek(timestamp) % 7');
    expect(q.query).toContain('toHour(timestamp)');
    expect(q.query).toContain('FROM user_activities');
  });

  it('given most-active-users, should group by user_id with a bound limit', () => {
    const q = buildMostActiveUsersQuery(WINDOW, 100);
    expect(q.query).toContain('GROUP BY user_id');
    expect(q.query_params.limit).toBe(100);
  });

  it('given feature usage, should group by action, top 15', () => {
    const q = buildFeatureUsageQuery(WINDOW);
    expect(q.query).toContain('GROUP BY action');
    expect(q.query_params.limit).toBe(15);
  });

  it('given active-user count, should count distinct user_id since the bound instant', () => {
    const q = buildActiveUserCountQuery(new Date('2021-03-05T10:45:00.000Z'));
    expect(q.query).toContain('uniqExact(user_id)');
    expect(q.query_params.tw_start).toBe('2021-03-05 10:45:00.000');
  });

  it('given response times, should aggregate avg/max/min per hour, 48 buckets', () => {
    const q = buildResponseTimesQuery(WINDOW);
    expect(q.query).toContain('max(duration)');
    expect(q.query).toContain('min(duration)');
    expect(q.query_params.limit).toBe(48);
  });

  it('given slow queries, should bind the duration threshold and order slowest first', () => {
    const q = buildSlowQueriesQuery(WINDOW);
    expect(q.query).toContain('duration >= {slow_ms: Int32}');
    expect(q.query).toContain('ORDER BY duration DESC');
    expect(q.query_params.slow_ms).toBe(5000);
  });

  it('given endpoint performance, should group by endpoint with no row cap (parity with the PG query)', () => {
    const q = buildEndpointPerformanceQuery(WINDOW);
    expect(q.query).toContain('GROUP BY endpoint');
    expect(q.query).not.toContain('LIMIT');
  });
});

describe('row parsers', () => {
  it('given logs-by-level rows, should coerce string counts', () => {
    expect(parseLogsByLevelRows([{ level: 'error', count: '3' }])).toEqual([
      { level: 'error', count: 3 },
    ]);
  });

  it('given a recent-error row, should return the PG reader shape (errorName=name, errorMessage=stack)', () => {
    const rows = parseRecentErrorRows([
      {
        id: 'e1',
        timestamp: '2021-03-05 10:30:00.123',
        message: 'boom',
        error_name: 'TypeError',
        stack: null,
        endpoint: '/api/x',
        user_id: null,
      },
    ]);
    expect(rows).toEqual([
      {
        id: 'e1',
        timestamp: new Date('2021-03-05T10:30:00.123Z'),
        message: 'boom',
        errorName: 'TypeError',
        errorMessage: null,
        endpoint: '/api/x',
        userId: null,
      },
    ]);
  });

  it('given volume rows, should produce Date buckets and numeric aggregates', () => {
    const rows = parseVolumeOverTimeRows([
      { hour: '2021-03-05 10:00:00', count: '2', avg_response_time: 15.5 },
    ]);
    expect(rows).toEqual([
      { hour: new Date('2021-03-05T10:00:00.000Z'), count: 2, avg_response_time: 15.5 },
    ]);
  });

  it('given top-endpoint rows, should map avgResponseTime', () => {
    expect(
      parseTopEndpointRows([{ endpoint: '/a', count: '5', avg_response_time: 10 }]),
    ).toEqual([{ endpoint: '/a', count: 5, avgResponseTime: 10 }]);
  });

  it('given a request/error count row, should return numeric totals', () => {
    expect(parseRequestErrorCounts([{ total: '10', errors: '2' }])).toEqual({
      total: 10,
      errors: 2,
    });
  });

  it('given no request/error count rows, should return zeros', () => {
    expect(parseRequestErrorCounts([])).toEqual({ total: 0, errors: 0 });
  });

  it("given an error-trend row with category '', should un-map to null (PG NULL parity)", () => {
    const rows = parseErrorTrendRows([
      { hour: '2021-03-05 10:00:00', category: '', count: '1' },
    ]);
    expect(rows).toEqual([
      { hour: new Date('2021-03-05T10:00:00.000Z'), category: null, count: 1 },
    ]);
  });

  it('given error-pattern rows, should keep nullable endpoint', () => {
    expect(parseErrorPatternRows([{ name: 'E', endpoint: null, count: '4' }])).toEqual([
      { name: 'E', endpoint: null, count: 4 },
    ]);
  });

  it('given failed-login rows, should parse metadata JSON back to an object', () => {
    const rows = parseFailedLoginRows([
      { timestamp: '2021-03-05 10:30:00.000', ip: '1.2.3.4', metadata: '{"email":"[masked]"}' },
    ]);
    expect(rows).toEqual([
      {
        timestamp: new Date('2021-03-05T10:30:00.000Z'),
        ip: '1.2.3.4',
        metadata: { email: '[masked]' },
      },
    ]);
  });

  it('given heatmap rows, should coerce all three fields to numbers', () => {
    expect(
      parseActivityHeatmapRows([{ day_of_week: 5, hour_of_day: 10, activity_count: '3' }]),
    ).toEqual([{ day_of_week: 5, hour_of_day: 10, activity_count: 3 }]);
  });

  it('given most-active-user rows, should map user_id/action_count', () => {
    expect(parseMostActiveUserRows([{ user_id: 'u1', action_count: '9' }])).toEqual([
      { userId: 'u1', actionCount: 9 },
    ]);
  });

  it('given feature-usage rows, should coerce counts', () => {
    expect(parseFeatureUsageRows([{ action: 'create', count: '2' }])).toEqual([
      { action: 'create', count: 2 },
    ]);
  });

  it('given an active-user count row, should return the number (0 when empty)', () => {
    expect(parseActiveUserCount([{ count: '4' }])).toBe(4);
    expect(parseActiveUserCount([])).toBe(0);
  });

  it('given response-time rows, should map the three aggregates', () => {
    expect(
      parseResponseTimeRows([
        {
          hour: '2021-03-05 10:00:00',
          avg_response_time: 10.5,
          max_response_time: 20,
          min_response_time: 1,
        },
      ]),
    ).toEqual([
      {
        hour: new Date('2021-03-05T10:00:00.000Z'),
        avg_response_time: 10.5,
        max_response_time: 20,
        min_response_time: 1,
      },
    ]);
  });

  it('given slow-query rows, should return the PG reader shape (responseTime=duration)', () => {
    expect(
      parseSlowQueryRows([
        {
          endpoint: '/slow',
          response_time: 6000,
          timestamp: '2021-03-05 10:30:00.000',
          user_id: 'u1',
        },
      ]),
    ).toEqual([
      {
        endpoint: '/slow',
        responseTime: 6000,
        timestamp: new Date('2021-03-05T10:30:00.000Z'),
        userId: 'u1',
      },
    ]);
  });

  it('given endpoint-performance rows, should map metric/avgValue/count', () => {
    expect(
      parseEndpointPerformanceRows([{ metric: '/a', avg_value: 3.5, count: '7' }]),
    ).toEqual([{ metric: '/a', avgValue: 3.5, count: 7 }]);
  });
});
