/**
 * GDPR surfaces for the ClickHouse analytics tier (#890 Phase 3 leaf 4).
 *
 * With CLICKHOUSE_ENABLED, new analytics rows land only in CH — so Art 15
 * export must read the subject's CH rows and Art 17 erasure must remove them.
 * error_logs deliberately has NO TTL (design ruling), which makes these
 * erasure mutations its ONLY eraser — they are not optional hygiene.
 *
 * Pure core: query/mutation builders (named params, never interpolated) and
 * JSONEachRow parsers to the exact shapes gdpr-export.ts produces from PG.
 * Column selection mirrors the PG collectors' deliberate exclusions —
 * ip/user_agent/session_id/request_id/stack/metadata are internal diagnostic
 * telemetry, not data about the subject's own activity.
 *
 * Shells: thin client wrappers. Errors PROPAGATE in both directions — an
 * incomplete export and a skipped erasure are both compliance failures, so
 * this path is fail-closed (unlike the never-throw insert adapters).
 *
 * Erasure uses lightweight DELETE (DELETE FROM … WHERE), the appropriate
 * mechanism for MergeTree: rows become invisible to queries as soon as the
 * statement completes; physical removal follows in background merges.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { ANALYTICS_TABLES } from './analytics-rows';
import { chDateTime, emptyToNull, type ChQuery } from './analytics-read-core';

// ── Export row shapes (PG-parity: gdpr-export.ts User*Export minus PG-only fields) ──

export interface ChUserSystemLogRow {
  id: string;
  timestamp: Date;
  level: string;
  message: string;
  category: string | null;
  endpoint: string | null;
  method: string | null;
  duration: number | null;
}

export interface ChUserApiMetricRow {
  id: string;
  timestamp: Date;
  endpoint: string;
  method: string;
  statusCode: number;
  duration: number;
  requestSize: number | null;
  responseSize: number | null;
}

/** No resolution state here — that lives in the error_resolutions PG mini-table. */
export interface ChUserErrorLogRow {
  id: string;
  timestamp: Date;
  name: string;
  message: string;
  endpoint: string | null;
  method: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
}

// ── Pure core: builders ──────────────────────────────────────────────────────

const bySubject = (columns: string, table: string): string => `
      SELECT ${columns}
      FROM ${table}
      WHERE user_id = {userId: String}
      ORDER BY timestamp
    `;

export const buildUserSystemLogsExportQuery = (userId: string): ChQuery => ({
  query: bySubject('id, timestamp, level, message, category, endpoint, method, duration', ANALYTICS_TABLES.systemLogs),
  query_params: { userId },
});

export const buildUserApiMetricsExportQuery = (userId: string): ChQuery => ({
  query: bySubject('id, timestamp, endpoint, method, status_code, duration, request_size, response_size', ANALYTICS_TABLES.apiMetrics),
  query_params: { userId },
});

export const buildUserErrorLogsExportQuery = (userId: string): ChQuery => ({
  query: bySubject('id, timestamp, name, message, endpoint, method, file, line, `column`', ANALYTICS_TABLES.errorLogs),
  query_params: { userId },
});

/** One lightweight DELETE per analytics table — the full Art 17 erasure set. */
export const buildUserErasureDeletes = (userId: string): ChQuery[] =>
  Object.values(ANALYTICS_TABLES).map((table) => ({
    query: `DELETE FROM ${table} WHERE user_id = {userId: String}`,
    query_params: { userId },
  }));

// ── Pure core: parsers ───────────────────────────────────────────────────────

export const parseUserSystemLogExportRows = (rows: unknown[]): ChUserSystemLogRow[] =>
  (rows as Array<{
    id: string; timestamp: string; level: string; message: string;
    category: string | null; endpoint: string | null; method: string | null; duration: number | null;
  }>).map((r) => ({
    id: r.id,
    timestamp: chDateTime(r.timestamp),
    level: r.level,
    message: r.message,
    // Un-map the leaf-2 write mapping: PG NULL category was stored as ''.
    category: emptyToNull(r.category),
    endpoint: r.endpoint,
    method: r.method,
    duration: r.duration,
  }));

export const parseUserApiMetricExportRows = (rows: unknown[]): ChUserApiMetricRow[] =>
  (rows as Array<{
    id: string; timestamp: string; endpoint: string; method: string;
    status_code: number; duration: number; request_size: number | null; response_size: number | null;
  }>).map((r) => ({
    id: r.id,
    timestamp: chDateTime(r.timestamp),
    endpoint: r.endpoint,
    method: r.method,
    statusCode: r.status_code,
    duration: r.duration,
    requestSize: r.request_size,
    responseSize: r.response_size,
  }));

export const parseUserErrorLogExportRows = (rows: unknown[]): ChUserErrorLogRow[] =>
  (rows as Array<{
    id: string; timestamp: string; name: string; message: string;
    endpoint: string | null; method: string | null; file: string | null;
    line: number | null; column: number | null;
  }>).map((r) => ({
    id: r.id,
    timestamp: chDateTime(r.timestamp),
    name: r.name,
    message: r.message,
    endpoint: r.endpoint,
    method: r.method,
    file: r.file,
    line: r.line,
    column: r.column,
  }));

// ── Shells ───────────────────────────────────────────────────────────────────

const selectRows = async (client: ClickHouseClient, built: ChQuery): Promise<unknown[]> => {
  const resultSet = await client.query({
    query: built.query,
    query_params: built.query_params,
    format: 'JSONEachRow',
  });
  return resultSet.json<unknown>();
};

export const collectChUserSystemLogs = async (
  client: ClickHouseClient,
  userId: string,
): Promise<ChUserSystemLogRow[]> =>
  parseUserSystemLogExportRows(await selectRows(client, buildUserSystemLogsExportQuery(userId)));

export const collectChUserApiMetrics = async (
  client: ClickHouseClient,
  userId: string,
): Promise<ChUserApiMetricRow[]> =>
  parseUserApiMetricExportRows(await selectRows(client, buildUserApiMetricsExportQuery(userId)));

export const collectChUserErrorLogs = async (
  client: ClickHouseClient,
  userId: string,
): Promise<ChUserErrorLogRow[]> =>
  parseUserErrorLogExportRows(await selectRows(client, buildUserErrorLogsExportQuery(userId)));

/** Art 17 erasure across all 4 analytics tables. Sequential and fail-closed. */
export const deleteChUserAnalytics = async (
  client: ClickHouseClient,
  userId: string,
): Promise<void> => {
  for (const built of buildUserErasureDeletes(userId)) {
    await client.command({ query: built.query, query_params: built.query_params });
  }
};
