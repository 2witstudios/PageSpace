#!/usr/bin/env bun
/**
 * ClickHouse analytics-tier migration (#890 Phase 3 leaf 2).
 *
 * Applies the MergeTree DDL for the 4 analytics tables (api_metrics,
 * system_logs, user_activities, error_logs) — idempotent CREATE TABLE IF NOT
 * EXISTS, safe to re-run anytime. Dev container and prod (ClickHouse Cloud)
 * run this same script; it is deliberately NOT an app-startup bootstrap so
 * the app runtime credential never needs DDL grants and a slow CH can't
 * delay app boot. The target DATABASE must already exist (the dev container
 * creates it from CLICKHOUSE_DB; ClickHouse Cloud from its console).
 *
 * Usage (env-driven, same vars as the app):
 *   CLICKHOUSE_ENABLED=true CLICKHOUSE_URL=http://localhost:8123 \
 *   CLICKHOUSE_USER=user CLICKHOUSE_PASSWORD=password \
 *   CLICKHOUSE_DATABASE=pagespace_analytics \
 *   bun run scripts/clickhouse-migrate.ts
 */

import {
  getClickHouseClient,
  getClickHouseMode,
} from '@pagespace/lib/observability/clickhouse-client';
import {
  ANALYTICS_TABLE_DDL,
  ensureAnalyticsTables,
} from '@pagespace/lib/observability/clickhouse-ddl';

async function main(): Promise<void> {
  const decision = getClickHouseMode();
  if (decision.mode !== 'enabled') {
    console.error(`[clickhouse-migrate] cannot run: ${decision.reason}`);
    console.error(
      '[clickhouse-migrate] set CLICKHOUSE_ENABLED=true plus CLICKHOUSE_URL (or CLICKHOUSE_HOST), CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DATABASE in the environment for this run.',
    );
    process.exit(1);
  }

  const client = getClickHouseClient();
  if (!client) {
    // Unreachable given the mode check above, but fail loudly rather than NPE.
    console.error('[clickhouse-migrate] client unexpectedly null despite enabled mode');
    process.exit(1);
  }

  console.log(`[clickhouse-migrate] target: ${decision.config.url} db=${decision.config.database}`);
  await ensureAnalyticsTables(client);
  for (const { table } of ANALYTICS_TABLE_DDL) {
    console.log(`[clickhouse-migrate] ensured table ${table}`);
  }
  await client.close();
  console.log('[clickhouse-migrate] done (idempotent — safe to re-run)');
}

main().catch((error) => {
  console.error('[clickhouse-migrate] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
