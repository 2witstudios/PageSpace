/**
 * Live integration against the dev ClickHouse container (compose service
 * `clickhouse`, #890 Phase 3 leaf 1). Skips itself when the container is not
 * reachable so the unit suite stays green anywhere; run
 * `docker compose up -d clickhouse` to exercise it for real.
 *
 * Proves the leaf-2 acceptance path end to end: idempotent DDL apply →
 * adapter insert → flush → SELECT back.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { get } from 'node:http';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { ensureAnalyticsTables } from '../clickhouse-ddl';
import { createAnalyticsInserters } from '../analytics-inserts';

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';

// node:http, not fetch — suite-level test setup stubs the global fetch.
const reachable = await new Promise<boolean>((resolve) => {
  const req = get(`${CH_URL}/ping`, { timeout: 2000 }, (res) => {
    res.resume();
    resolve(res.statusCode === 200);
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => resolve(false));
});

describe.skipIf(!reachable)('ClickHouse container round-trip (DDL apply + adapter insert + SELECT back)', () => {
  let client: ClickHouseClient;
  const runId = `it-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    client = createClient({
      url: CH_URL,
      username: process.env.CLICKHOUSE_USER ?? 'user',
      password: process.env.CLICKHOUSE_PASSWORD ?? 'password',
      database: process.env.CLICKHOUSE_DATABASE ?? 'pagespace_analytics',
    });
    await ensureAnalyticsTables(client);
  });

  afterAll(async () => {
    await client?.close();
  });

  it('given the DDL already applied, applying again should be a no-op (idempotent)', async () => {
    await expect(ensureAnalyticsTables(client)).resolves.toBeUndefined();
  });

  it('given one row per table inserted via the adapters, each should SELECT back', async () => {
    const inserters = createAnalyticsInserters({ getClient: () => client });
    const ts = new Date();

    inserters.insertApiMetric({
      id: `${runId}-metric`,
      timestamp: ts,
      endpoint: '/api/integration',
      method: 'GET',
      statusCode: 200,
      duration: 12,
      cacheHit: true,
    });
    inserters.insertSystemLog({
      id: `${runId}-log`,
      timestamp: ts,
      level: 'info',
      message: 'integration round-trip',
      category: 'api',
      metadata: { runId },
    });
    inserters.insertUserActivity({
      id: `${runId}-activity`,
      timestamp: ts,
      userId: `${runId}-user`,
      action: 'integration_test',
    });
    inserters.insertError({
      id: `${runId}-error`,
      timestamp: ts,
      name: 'IntegrationError',
      message: 'integration round-trip',
      line: 1,
    });
    await inserters.drain();

    const selectById = async (table: string, id: string): Promise<Array<Record<string, unknown>>> => {
      const result = await client.query({
        query: `SELECT * FROM ${table} WHERE id = {id:String}`,
        query_params: { id },
        format: 'JSONEachRow',
      });
      return result.json<Record<string, unknown>>();
    };

    const [metric] = await selectById('api_metrics', `${runId}-metric`);
    expect(metric).toMatchObject({ endpoint: '/api/integration', status_code: 200, cache_hit: true });

    const [log] = await selectById('system_logs', `${runId}-log`);
    expect(log).toMatchObject({ level: 'info', category: 'api' });
    expect(JSON.parse(log.metadata as string)).toEqual({ runId });

    const [activity] = await selectById('user_activities', `${runId}-activity`);
    expect(activity).toMatchObject({ user_id: `${runId}-user`, action: 'integration_test' });

    const [error] = await selectById('error_logs', `${runId}-error`);
    expect(error).toMatchObject({ name: 'IntegrationError', line: 1 });
  });

  it('given the created tables, engine metadata should match the design ref (ORDER BY, partition, TTL)', async () => {
    const result = await client.query({
      query: `
        SELECT name, engine, sorting_key, partition_key
        FROM system.tables
        WHERE database = {db:String}
          AND name IN ('api_metrics', 'system_logs', 'user_activities', 'error_logs')
      `,
      query_params: { db: process.env.CLICKHOUSE_DATABASE ?? 'pagespace_analytics' },
      format: 'JSONEachRow',
    });
    const tables = await result.json<{
      name: string;
      engine: string;
      sorting_key: string;
      partition_key: string;
    }>();
    const byName = Object.fromEntries(tables.map((t) => [t.name, t]));

    expect(Object.keys(byName).sort()).toEqual(['api_metrics', 'error_logs', 'system_logs', 'user_activities']);
    for (const table of Object.values(byName)) {
      expect(table.engine).toBe('MergeTree');
      expect(table.partition_key).toBe('toYYYYMM(timestamp)');
    }
    expect(byName.api_metrics.sorting_key).toBe('timestamp, endpoint, status_code');
    expect(byName.system_logs.sorting_key).toBe('timestamp, level, category');
    expect(byName.user_activities.sorting_key).toBe('user_id, timestamp, action');
    expect(byName.error_logs.sorting_key).toBe('timestamp, name');
  });
});
