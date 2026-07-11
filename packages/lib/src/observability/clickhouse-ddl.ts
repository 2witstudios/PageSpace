/**
 * MergeTree DDL for the ClickHouse analytics tier (#890 Phase 3 leaf 2).
 * Design ref lkjmhbmjekgbntk2z4rsjzw2 is authoritative for ORDER BY,
 * LowCardinality, and TTL choices.
 *
 * Migration mechanism: an explicit, idempotent apply (CREATE TABLE IF NOT
 * EXISTS) driven by scripts/clickhouse-migrate.ts — dev container and prod
 * run the same script. Deliberately NOT a startup bootstrap: the app runtime
 * credential then never needs DDL grants (zero-trust: app = INSERT-only,
 * mirroring the Admin PG role split), and a slow/unreachable CH can't delay
 * or fail app boot.
 *
 * Column shapes mirror packages/db/src/schema/monitoring.ts:
 *   text → String / Nullable(String) · integer → Int32 · boolean → Bool
 *   jsonb → String (JSON-serialized) · timestamp → DateTime64(3, 'UTC')
 * Two deliberate divergences: system_logs.category is an ORDER BY key so PG
 * NULL maps to '' (sorting keys cannot be Nullable), and error_logs drops the
 * mutable resolution workflow columns (resolved/resolvedAt/resolvedBy/
 * resolution) — CH rows are immutable; the resolved-flag workflow moves to an
 * error_resolutions mini-table in main PG (leaf 3).
 */

import type { AnalyticsTable } from './analytics-rows';

export interface AnalyticsTableDdl {
  table: AnalyticsTable;
  ddl: string;
}

export const ANALYTICS_TABLE_DDL: readonly AnalyticsTableDdl[] = [
  {
    table: 'api_metrics',
    ddl: `
      CREATE TABLE IF NOT EXISTS api_metrics (
        \`id\` String,
        \`timestamp\` DateTime64(3, 'UTC'),
        \`endpoint\` LowCardinality(String),
        \`method\` LowCardinality(String),
        \`status_code\` Int32,
        \`duration\` Int32,
        \`request_size\` Nullable(Int32),
        \`response_size\` Nullable(Int32),
        \`user_id\` Nullable(String),
        \`session_id\` Nullable(String),
        \`ip\` Nullable(String),
        \`user_agent\` Nullable(String),
        \`error\` Nullable(String),
        \`request_id\` Nullable(String),
        \`cache_hit\` Nullable(Bool),
        \`cache_key\` Nullable(String)
      )
      ENGINE = MergeTree
      PARTITION BY toYYYYMM(timestamp)
      ORDER BY (timestamp, endpoint, status_code)
      TTL toDateTime(timestamp) + INTERVAL 90 DAY
    `,
  },
  {
    table: 'system_logs',
    ddl: `
      CREATE TABLE IF NOT EXISTS system_logs (
        \`id\` String,
        \`timestamp\` DateTime64(3, 'UTC'),
        \`level\` LowCardinality(String),
        \`message\` String,
        \`category\` LowCardinality(String) DEFAULT '',
        \`user_id\` Nullable(String),
        \`session_id\` Nullable(String),
        \`request_id\` Nullable(String),
        \`drive_id\` Nullable(String),
        \`page_id\` Nullable(String),
        \`endpoint\` Nullable(String),
        \`method\` LowCardinality(Nullable(String)),
        \`ip\` Nullable(String),
        \`user_agent\` Nullable(String),
        \`error_name\` Nullable(String),
        \`error_message\` Nullable(String),
        \`error_stack\` Nullable(String),
        \`duration\` Nullable(Int32),
        \`memory_used\` Nullable(Int32),
        \`memory_total\` Nullable(Int32),
        \`metadata\` Nullable(String),
        \`hostname\` Nullable(String),
        \`pid\` Nullable(Int32),
        \`version\` Nullable(String)
      )
      ENGINE = MergeTree
      PARTITION BY toYYYYMM(timestamp)
      ORDER BY (timestamp, level, category)
      TTL toDateTime(timestamp) + INTERVAL 30 DAY
    `,
  },
  {
    table: 'user_activities',
    ddl: `
      CREATE TABLE IF NOT EXISTS user_activities (
        \`id\` String,
        \`timestamp\` DateTime64(3, 'UTC'),
        \`user_id\` String,
        \`action\` LowCardinality(String),
        \`session_id\` Nullable(String),
        \`resource\` LowCardinality(Nullable(String)),
        \`resource_id\` Nullable(String),
        \`drive_id\` Nullable(String),
        \`page_id\` Nullable(String),
        \`metadata\` Nullable(String),
        \`ip\` Nullable(String),
        \`user_agent\` Nullable(String)
      )
      ENGINE = MergeTree
      PARTITION BY toYYYYMM(timestamp)
      ORDER BY (user_id, timestamp, action)
      TTL toDateTime(timestamp) + INTERVAL 180 DAY
    `,
  },
  {
    table: 'error_logs',
    ddl: `
      CREATE TABLE IF NOT EXISTS error_logs (
        \`id\` String,
        \`timestamp\` DateTime64(3, 'UTC'),
        \`name\` LowCardinality(String),
        \`message\` String,
        \`stack\` Nullable(String),
        \`user_id\` Nullable(String),
        \`session_id\` Nullable(String),
        \`request_id\` Nullable(String),
        \`endpoint\` Nullable(String),
        \`method\` LowCardinality(Nullable(String)),
        \`file\` Nullable(String),
        \`line\` Nullable(Int32),
        \`column\` Nullable(Int32),
        \`ip\` Nullable(String),
        \`user_agent\` Nullable(String),
        \`metadata\` Nullable(String)
      )
      ENGINE = MergeTree
      PARTITION BY toYYYYMM(timestamp)
      ORDER BY (timestamp, name)
    `,
  },
];

/** Structural slice of ClickHouseClient — DDL needs only command(). */
export interface ClickHouseCommandRunner {
  command: (params: { query: string }) => Promise<unknown>;
}

/**
 * Apply the analytics DDL. Idempotent (IF NOT EXISTS); errors PROPAGATE —
 * a migration that cannot apply must fail loudly, unlike the insert path.
 */
export async function ensureAnalyticsTables(client: ClickHouseCommandRunner): Promise<void> {
  for (const { ddl } of ANALYTICS_TABLE_DDL) {
    await client.command({ query: ddl });
  }
}
