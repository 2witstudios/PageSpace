/**
 * Pure core of the ClickHouse analytics READ path (#890 Phase 3 leaf 3).
 *
 * The admin/web monitoring readers re-point to ClickHouse post-cutover; this
 * module holds every piece of that path that is logic rather than I/O:
 * query builders (SQL text + named params — dynamic values are ALWAYS bound,
 * never interpolated) and row parsers that convert JSONEachRow output back
 * to the exact runtime shapes the old PG queries produced (Date objects for
 * timestamps/buckets, numbers for counts — CH serializes UInt64 as strings —
 * and null where PG returned NULL, including the system_logs.category ''
 * stand-in introduced by the leaf-2 write mapping).
 *
 * Aggregations run in CH SQL (its strength), shaped to exploit the MergeTree
 * ORDER BY keys from clickhouse-ddl.ts: api_metrics (timestamp, endpoint,
 * status_code) · system_logs (timestamp, level, category) · user_activities
 * (user_id, timestamp, action) · error_logs (timestamp, name).
 *
 * The execution shells live in analytics-reads.ts.
 */

import { toClickHouseDateTime64 } from './analytics-rows';

export interface TimeWindow {
  startDate?: Date;
  endDate?: Date;
}

export interface ChQuery {
  query: string;
  query_params: Record<string, unknown>;
}

// ── Value coercion (JSONEachRow → PG-parity runtime values) ──────────────────

/** count()/countIf() come back as UInt64 strings; missing → 0. */
export const chCount = (value: unknown): number =>
  value === null || value === undefined ? 0 : Number(value);

/** avg()/max()/min() — Float64 numbers, or null (CH serializes nan as null). */
export const chNullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** DateTime / DateTime64(3) rendered in the column's UTC timezone → Date. */
export const chDateTime = (value: string): Date => new Date(`${value.replace(' ', 'T')}Z`);

/** Un-map the leaf-2 write mapping: PG NULL category was stored as '' in CH. */
export const emptyToNull = (value: string | null): string | null =>
  value === '' || value === null ? null : value;

/** jsonb columns were serialized to CH String; parse back to the jsonb Record shape. */
export const parseChMetadata = (value: string | null): Record<string, unknown> | null => {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
};

// ── Shared window fragment ───────────────────────────────────────────────────

const windowFragment = (
  window: TimeWindow,
): { conditions: string[]; params: Record<string, unknown> } => {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (window.startDate) {
    conditions.push('timestamp >= {tw_start: DateTime64(3)}');
    params.tw_start = toClickHouseDateTime64(window.startDate);
  }
  if (window.endDate) {
    conditions.push('timestamp <= {tw_end: DateTime64(3)}');
    params.tw_end = toClickHouseDateTime64(window.endDate);
  }
  return { conditions, params };
};

const whereClause = (conditions: string[]): string =>
  conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

// ── system_logs ──────────────────────────────────────────────────────────────

export const buildLogsByLevelQuery = (window: TimeWindow): ChQuery => {
  const { conditions, params } = windowFragment(window);
  return {
    query: `
      SELECT level, count() AS count
      FROM system_logs
      ${whereClause(conditions)}
      GROUP BY level
    `,
    query_params: params,
  };
};

export interface LogsByLevelRow {
  level: string;
  count: number;
}

export const parseLogsByLevelRows = (rows: unknown[]): LogsByLevelRow[] =>
  (rows as Array<{ level: string; count: unknown }>).map((r) => ({
    level: r.level,
    count: chCount(r.count),
  }));

export const buildErrorTrendsQuery = (window: TimeWindow): ChQuery => {
  const { conditions, params } = windowFragment(window);
  return {
    query: `
      SELECT toStartOfHour(timestamp) AS hour, category, count() AS count
      FROM system_logs
      ${whereClause(["level = 'error'", ...conditions])}
      GROUP BY hour, category
      ORDER BY hour DESC
      LIMIT {limit: UInt32}
    `,
    query_params: { ...params, limit: 168 },
  };
};

export interface ErrorTrendRow {
  hour: Date;
  category: string | null;
  count: number;
}

export const parseErrorTrendRows = (rows: unknown[]): ErrorTrendRow[] =>
  (rows as Array<{ hour: string; category: string | null; count: unknown }>).map((r) => ({
    hour: chDateTime(r.hour),
    category: emptyToNull(r.category),
    count: chCount(r.count),
  }));

export const buildFailedLoginsQuery = (window: TimeWindow): ChQuery => {
  const { conditions, params } = windowFragment(window);
  return {
    query: `
      SELECT timestamp, ip, metadata
      FROM system_logs
      ${whereClause(["category = 'auth'", "level IN ('warn', 'error')", ...conditions])}
      ORDER BY timestamp DESC
      LIMIT {limit: UInt32}
    `,
    query_params: { ...params, limit: 25 },
  };
};

export interface FailedLoginRow {
  timestamp: Date;
  ip: string | null;
  metadata: Record<string, unknown> | null;
}

export const parseFailedLoginRows = (rows: unknown[]): FailedLoginRow[] =>
  (rows as Array<{ timestamp: string; ip: string | null; metadata: string | null }>).map(
    (r) => ({
      timestamp: chDateTime(r.timestamp),
      ip: r.ip,
      metadata: parseChMetadata(r.metadata),
    }),
  );

// ── error_logs ───────────────────────────────────────────────────────────────

export const buildRecentErrorsQuery = (window: TimeWindow, limit: number): ChQuery => {
  const { conditions, params } = windowFragment(window);
  return {
    query: `
      SELECT id, timestamp, message, name AS error_name, stack, endpoint, user_id
      FROM error_logs
      ${whereClause(conditions)}
      ORDER BY timestamp DESC
      LIMIT {limit: UInt32}
    `,
    query_params: { ...params, limit },
  };
};

export interface RecentErrorRow {
  id: string;
  timestamp: Date;
  message: string;
  errorName: string;
  errorMessage: string | null;
  endpoint: string | null;
  userId: string | null;
}

export const parseRecentErrorRows = (rows: unknown[]): RecentErrorRow[] =>
  (
    rows as Array<{
      id: string;
      timestamp: string;
      message: string;
      error_name: string;
      stack: string | null;
      endpoint: string | null;
      user_id: string | null;
    }>
  ).map((r) => ({
    id: r.id,
    timestamp: chDateTime(r.timestamp),
    message: r.message,
    errorName: r.error_name,
    errorMessage: r.stack,
    endpoint: r.endpoint,
    userId: r.user_id,
  }));

export const buildErrorPatternsQuery = (window: TimeWindow): ChQuery => {
  const { conditions, params } = windowFragment(window);
  return {
    query: `
      SELECT name, endpoint, count() AS count
      FROM error_logs
      ${whereClause(conditions)}
      GROUP BY name, endpoint
      ORDER BY count DESC
      LIMIT {limit: UInt32}
    `,
    query_params: { ...params, limit: 20 },
  };
};

export interface ErrorPatternRow {
  name: string;
  endpoint: string | null;
  count: number;
}

export const parseErrorPatternRows = (rows: unknown[]): ErrorPatternRow[] =>
  (rows as Array<{ name: string; endpoint: string | null; count: unknown }>).map((r) => ({
    name: r.name,
    endpoint: r.endpoint,
    count: chCount(r.count),
  }));

// ── api_metrics ──────────────────────────────────────────────────────────────

export const buildVolumeOverTimeQuery = (window: TimeWindow): ChQuery => {
  const { conditions, params } = windowFragment(window);
  return {
    query: `
      SELECT toStartOfHour(timestamp) AS hour, count() AS count, avg(duration) AS avg_response_time
      FROM api_metrics
      ${whereClause(conditions)}
      GROUP BY hour
      ORDER BY hour DESC
      LIMIT {limit: UInt32}
    `,
    query_params: { ...params, limit: 168 },
  };
};

export interface VolumeOverTimeRow {
  hour: Date;
  count: number;
  avg_response_time: number | null;
}

export const parseVolumeOverTimeRows = (rows: unknown[]): VolumeOverTimeRow[] =>
  (rows as Array<{ hour: string; count: unknown; avg_response_time: unknown }>).map((r) => ({
    hour: chDateTime(r.hour),
    count: chCount(r.count),
    avg_response_time: chNullableNumber(r.avg_response_time),
  }));

export const buildTopEndpointsQuery = (window: TimeWindow): ChQuery => {
  const { conditions, params } = windowFragment(window);
  return {
    query: `
      SELECT endpoint, count() AS count, avg(duration) AS avg_response_time
      FROM api_metrics
      ${whereClause(conditions)}
      GROUP BY endpoint
      ORDER BY count DESC
      LIMIT {limit: UInt32}
    `,
    query_params: { ...params, limit: 10 },
  };
};

export interface TopEndpointRow {
  endpoint: string;
  count: number;
  avgResponseTime: number | null;
}

export const parseTopEndpointRows = (rows: unknown[]): TopEndpointRow[] =>
  (rows as Array<{ endpoint: string; count: unknown; avg_response_time: unknown }>).map(
    (r) => ({
      endpoint: r.endpoint,
      count: chCount(r.count),
      avgResponseTime: chNullableNumber(r.avg_response_time),
    }),
  );

export const buildRequestErrorCountsQuery = (window: TimeWindow): ChQuery => {
  const { conditions, params } = windowFragment(window);
  return {
    query: `
      SELECT count() AS total, countIf(status_code >= 400) AS errors
      FROM api_metrics
      ${whereClause(conditions)}
    `,
    query_params: params,
  };
};

export interface RequestErrorCounts {
  total: number;
  errors: number;
}

export const parseRequestErrorCounts = (rows: unknown[]): RequestErrorCounts => {
  const row = (rows as Array<{ total: unknown; errors: unknown }>)[0];
  return { total: chCount(row?.total), errors: chCount(row?.errors) };
};

export const buildResponseTimesQuery = (window: TimeWindow): ChQuery => {
  const { conditions, params } = windowFragment(window);
  return {
    query: `
      SELECT
        toStartOfHour(timestamp) AS hour,
        avg(duration) AS avg_response_time,
        max(duration) AS max_response_time,
        min(duration) AS min_response_time
      FROM api_metrics
      ${whereClause(conditions)}
      GROUP BY hour
      ORDER BY hour DESC
      LIMIT {limit: UInt32}
    `,
    query_params: { ...params, limit: 48 },
  };
};

export interface ResponseTimeRow {
  hour: Date;
  avg_response_time: number | null;
  max_response_time: number | null;
  min_response_time: number | null;
}

export const parseResponseTimeRows = (rows: unknown[]): ResponseTimeRow[] =>
  (
    rows as Array<{
      hour: string;
      avg_response_time: unknown;
      max_response_time: unknown;
      min_response_time: unknown;
    }>
  ).map((r) => ({
    hour: chDateTime(r.hour),
    avg_response_time: chNullableNumber(r.avg_response_time),
    max_response_time: chNullableNumber(r.max_response_time),
    min_response_time: chNullableNumber(r.min_response_time),
  }));

export const buildSlowQueriesQuery = (
  window: TimeWindow,
  thresholdMs = 5000,
  limit = 20,
): ChQuery => {
  const { conditions, params } = windowFragment(window);
  return {
    query: `
      SELECT endpoint, duration AS response_time, timestamp, user_id
      FROM api_metrics
      ${whereClause(['duration >= {slow_ms: Int32}', ...conditions])}
      ORDER BY duration DESC
      LIMIT {limit: UInt32}
    `,
    query_params: { ...params, slow_ms: thresholdMs, limit },
  };
};

export interface SlowQueryRow {
  endpoint: string;
  responseTime: number;
  timestamp: Date;
  userId: string | null;
}

export const parseSlowQueryRows = (rows: unknown[]): SlowQueryRow[] =>
  (
    rows as Array<{
      endpoint: string;
      response_time: number;
      timestamp: string;
      user_id: string | null;
    }>
  ).map((r) => ({
    endpoint: r.endpoint,
    responseTime: Number(r.response_time),
    timestamp: chDateTime(r.timestamp),
    userId: r.user_id,
  }));

export const buildEndpointPerformanceQuery = (window: TimeWindow): ChQuery => {
  const { conditions, params } = windowFragment(window);
  return {
    query: `
      SELECT endpoint AS metric, avg(duration) AS avg_value, count() AS count
      FROM api_metrics
      ${whereClause(conditions)}
      GROUP BY endpoint
      ORDER BY count DESC
    `,
    query_params: params,
  };
};

export interface EndpointPerformanceRow {
  metric: string;
  avgValue: number | null;
  count: number;
}

export const parseEndpointPerformanceRows = (rows: unknown[]): EndpointPerformanceRow[] =>
  (rows as Array<{ metric: string; avg_value: unknown; count: unknown }>).map((r) => ({
    metric: r.metric,
    avgValue: chNullableNumber(r.avg_value),
    count: chCount(r.count),
  }));

// ── user_activities ──────────────────────────────────────────────────────────

export const buildActivityHeatmapQuery = (window: TimeWindow): ChQuery => {
  const { conditions, params } = windowFragment(window);
  return {
    query: `
      SELECT
        toDayOfWeek(timestamp) % 7 AS day_of_week,
        toHour(timestamp) AS hour_of_day,
        count() AS activity_count
      FROM user_activities
      ${whereClause(conditions)}
      GROUP BY day_of_week, hour_of_day
    `,
    query_params: params,
  };
};

export interface ActivityHeatmapRow {
  day_of_week: number;
  hour_of_day: number;
  activity_count: number;
}

export const parseActivityHeatmapRows = (rows: unknown[]): ActivityHeatmapRow[] =>
  (rows as Array<{ day_of_week: unknown; hour_of_day: unknown; activity_count: unknown }>).map(
    (r) => ({
      day_of_week: Number(r.day_of_week),
      hour_of_day: Number(r.hour_of_day),
      activity_count: chCount(r.activity_count),
    }),
  );

export const buildMostActiveUsersQuery = (window: TimeWindow, limit: number): ChQuery => {
  const { conditions, params } = windowFragment(window);
  return {
    query: `
      SELECT user_id, count() AS action_count
      FROM user_activities
      ${whereClause(conditions)}
      GROUP BY user_id
      ORDER BY action_count DESC
      LIMIT {limit: UInt32}
    `,
    query_params: { ...params, limit },
  };
};

export interface MostActiveUserRow {
  userId: string;
  actionCount: number;
}

export const parseMostActiveUserRows = (rows: unknown[]): MostActiveUserRow[] =>
  (rows as Array<{ user_id: string; action_count: unknown }>).map((r) => ({
    userId: r.user_id,
    actionCount: chCount(r.action_count),
  }));

export const buildFeatureUsageQuery = (window: TimeWindow): ChQuery => {
  const { conditions, params } = windowFragment(window);
  return {
    query: `
      SELECT action, count() AS count
      FROM user_activities
      ${whereClause(conditions)}
      GROUP BY action
      ORDER BY count DESC
      LIMIT {limit: UInt32}
    `,
    query_params: { ...params, limit: 15 },
  };
};

export interface FeatureUsageRow {
  action: string;
  count: number;
}

export const parseFeatureUsageRows = (rows: unknown[]): FeatureUsageRow[] =>
  (rows as Array<{ action: string; count: unknown }>).map((r) => ({
    action: r.action,
    count: chCount(r.count),
  }));

export const buildActiveUserCountQuery = (since: Date): ChQuery => ({
  query: `
    SELECT uniqExact(user_id) AS count
    FROM user_activities
    WHERE timestamp >= {tw_start: DateTime64(3)}
  `,
  query_params: { tw_start: toClickHouseDateTime64(since) },
});

export const parseActiveUserCount = (rows: unknown[]): number =>
  chCount((rows as Array<{ count: unknown }>)[0]?.count);
