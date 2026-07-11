/**
 * Live GDPR round-trip against the dev ClickHouse container (#890 Phase 3
 * leaf 4). Skips itself when the container is not reachable; run
 * `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d clickhouse`
 * to exercise it for real.
 *
 * Proves the two compliance paths end to end with real CH semantics:
 *   Art 15 — collectCh* return exactly the subject's rows;
 *   Art 17 — deleteChUserAnalytics removes the subject's rows from all 4
 *   tables (lightweight DELETE) while a bystander's rows survive.
 * Timestamps are seeded ~1h back — INSIDE every table TTL horizon, otherwise
 * CH silently drops them at insert (optimize_on_insert; see phase Findings).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { get } from 'node:http';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { ensureAnalyticsTables } from '../clickhouse-ddl';
import { ANALYTICS_TABLES, toClickHouseDateTime64 } from '../analytics-rows';
import {
  collectChUserSystemLogs,
  collectChUserApiMetrics,
  collectChUserErrorLogs,
  deleteChUserAnalytics,
} from '../analytics-gdpr';

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

describe.skipIf(!reachable)('GDPR round-trip on the CH container (export reads + erasure deletes)', () => {
  let client: ClickHouseClient;
  const runId = `gdpr-${Math.random().toString(36).slice(2)}`;
  const subject = `${runId}-subject`;
  const bystander = `${runId}-bystander`;
  const ts = toClickHouseDateTime64(new Date(Date.now() - 60 * 60 * 1000));

  const countByUser = async (table: string, userId: string): Promise<number> => {
    const rs = await client.query({
      query: `SELECT count() AS c FROM ${table} WHERE user_id = {userId: String}`,
      query_params: { userId },
      format: 'JSONEachRow',
    });
    const rows = await rs.json<{ c: string }>();
    return Number(rows[0]?.c ?? 0);
  };

  beforeAll(async () => {
    client = createClient({
      url: CH_URL,
      username: process.env.CLICKHOUSE_USER ?? 'user',
      password: process.env.CLICKHOUSE_PASSWORD ?? 'password',
      database: process.env.CLICKHOUSE_DATABASE ?? 'pagespace_analytics',
    });
    await ensureAnalyticsTables(client);

    const insert = (table: string, values: Record<string, unknown>[]) =>
      client.insert({ table, values, format: 'JSONEachRow' });

    for (const userId of [subject, bystander]) {
      await Promise.all([
        insert(ANALYTICS_TABLES.systemLogs, [
          { id: `${userId}-sl`, timestamp: ts, level: 'info', message: `log for ${userId}`, user_id: userId },
        ]),
        insert(ANALYTICS_TABLES.apiMetrics, [
          {
            id: `${userId}-am`, timestamp: ts, endpoint: '/api/gdpr-it', method: 'GET',
            status_code: 200, duration: 5, user_id: userId,
          },
        ]),
        insert(ANALYTICS_TABLES.userActivities, [
          { id: `${userId}-ua`, timestamp: ts, user_id: userId, action: 'gdpr-it' },
        ]),
        insert(ANALYTICS_TABLES.errorLogs, [
          { id: `${userId}-el`, timestamp: ts, name: 'ItError', message: `error for ${userId}`, user_id: userId },
        ]),
      ]);
    }
  });

  afterAll(async () => {
    // Remove the bystander's rows too so reruns start clean.
    if (client) {
      await deleteChUserAnalytics(client, bystander);
      await client.close();
    }
  });

  it('given rows from two users, export collectors should return exactly the subject rows', async () => {
    const [sysRows, metricRows, errorRows] = await Promise.all([
      collectChUserSystemLogs(client, subject),
      collectChUserApiMetrics(client, subject),
      collectChUserErrorLogs(client, subject),
    ]);

    expect(sysRows.map((r) => r.id)).toEqual([`${subject}-sl`]);
    expect(sysRows[0].message).toBe(`log for ${subject}`);
    expect(sysRows[0].timestamp).toBeInstanceOf(Date);
    expect(sysRows[0].category).toBeNull(); // '' write-mapping round-trips to null

    expect(metricRows.map((r) => r.id)).toEqual([`${subject}-am`]);
    expect(metricRows[0].statusCode).toBe(200);

    expect(errorRows.map((r) => r.id)).toEqual([`${subject}-el`]);
    expect('resolved' in errorRows[0]).toBe(false);
  });

  it('given an erasure, the subject vanishes from all 4 tables while the bystander survives', async () => {
    await deleteChUserAnalytics(client, subject);

    for (const table of Object.values(ANALYTICS_TABLES)) {
      expect(await countByUser(table, subject), `${table} subject`).toBe(0);
      expect(await countByUser(table, bystander), `${table} bystander`).toBe(1);
    }
  });
});
