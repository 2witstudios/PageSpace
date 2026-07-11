/**
 * CH-vs-PG parity for the re-pointed admin monitoring readers (#890 Phase 3
 * leaf 3) — the acceptance backbone for the admin read cutover.
 *
 * Both stores are seeded with the SAME logical rows inside a random past
 * hour-aligned window unique to this run, then each re-pointed reader runs
 * flag-off (PG path) and flag-on (CH path) and the outputs are compared
 * after normalization. The window sits 4–6 days in the past: recent enough
 * for the CH TTLs (system_logs 30d is the tightest — ClickHouse drops
 * already-expired rows at insert time), old enough that nothing else writes
 * into it, and in a different band from the web parity suite so concurrent
 * runs never overlap.
 *
 * Admin-specific pins: the active-user count stays on PG sessions in BOTH
 * modes, and failedLogins metadata is email-masked identically on both
 * paths.
 *
 * Requires DATABASE_URL → migrated Postgres AND the dev ClickHouse container
 * (docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
 * clickhouse). Skips itself when either store is unreachable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { get } from 'node:http';
import {
  getClickHouseClient,
  type ClickHouseClient,
} from '@pagespace/lib/observability/clickhouse-client';
import { db } from '@pagespace/db/db';
import { like } from '@pagespace/db/operators';
import { apiMetrics, systemLogs, errorLogs } from '@pagespace/db/schema/monitoring';
import { ensureAnalyticsTables } from '@pagespace/lib/observability/clickhouse-ddl';
import {
  mapApiMetricToRow,
  mapSystemLogToRow,
  mapErrorLogToRow,
} from '@pagespace/lib/observability/analytics-rows';
import { getSystemHealth, getApiMetrics, getErrorAnalytics } from '../monitoring-queries';

// PG DATE_TRUNC buckets in the server's local zone while CH buckets in UTC;
// production runs UTC, so the parity contract (and this test) is UTC.
process.env.TZ = 'UTC';

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_ENV = {
  CLICKHOUSE_ENABLED: 'true',
  CLICKHOUSE_URL: CH_URL,
  CLICKHOUSE_USER: process.env.CLICKHOUSE_USER ?? 'user',
  CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? 'password',
  CLICKHOUSE_DATABASE: process.env.CLICKHOUSE_DATABASE ?? 'pagespace_analytics',
};

const chReachable = await new Promise<boolean>((resolve) => {
  const req = get(`${CH_URL}/ping`, { timeout: 2000 }, (res) => {
    res.resume();
    resolve(res.statusCode === 200);
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => resolve(false));
});

const pgReachable = await (async () => {
  try {
    await db.select({ id: errorLogs.id }).from(errorLogs).limit(1);
    return true;
  } catch {
    return false;
  }
})();

// Random hour-aligned window 4–6 days ago (see header).
const WINDOW_START = new Date(
  Math.floor((Date.now() - 144 * 3_600_000) / 3_600_000) * 3_600_000 +
    Math.floor(Math.random() * 48) * 3_600_000,
);
const WINDOW_END = new Date(WINDOW_START.getTime() + 2 * 3_600_000);
const runId = `parity-admin-${WINDOW_START.getTime()}-${Math.floor(Math.random() * 1e6)}`;
const at = (minutes: number): Date => new Date(WINDOW_START.getTime() + minutes * 60_000);

async function withClickHouse<T>(fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(CH_ENV)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v) * 1e6) / 1e6);
const byKey = <T>(key: (r: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));

let chClient: ClickHouseClient;

describe.skipIf(!chReachable || !pgReachable)(
  'admin monitoring readers: ClickHouse path ≡ Postgres path on identically seeded data',
  () => {
    beforeAll(async () => {
      chClient = (await withClickHouse(async () => getClickHouseClient()))!;
      await ensureAnalyticsTables(chClient);

      const metricRows = [
        { id: `${runId}-m1`, timestamp: at(5), endpoint: '/api/pages', method: 'GET', statusCode: 200, duration: 80 },
        { id: `${runId}-m2`, timestamp: at(10), endpoint: '/api/pages', method: 'GET', statusCode: 500, duration: 240 },
        { id: `${runId}-m3`, timestamp: at(65), endpoint: '/api/drives', method: 'POST', statusCode: 200, duration: 120 },
      ] as const;

      const logRows = [
        { id: `${runId}-s1`, timestamp: at(6), level: 'info', message: 'ok', category: 'api' },
        { id: `${runId}-s2`, timestamp: at(12), level: 'error', message: 'blew up', category: undefined },
        { id: `${runId}-s3`, timestamp: at(66), level: 'warn', message: 'login failed', category: 'auth', ip: '5.5.5.5', metadata: { detail: 'login failed for jane@example.com' } },
        { id: `${runId}-s4`, timestamp: at(70), level: 'error', message: 'lockout', category: 'auth', metadata: { nested: { contact: 'bob@corp.io' } } },
      ] as const;

      const errorRows = [
        { id: `${runId}-e1`, timestamp: at(15), name: 'TypeError', message: 'boom', stack: 'trace1', endpoint: '/api/pages' },
        { id: `${runId}-e2`, timestamp: at(20), name: 'TypeError', message: 'bang', stack: undefined, endpoint: '/api/pages' },
        { id: `${runId}-e3`, timestamp: at(67), name: 'RangeError', message: 'oops', stack: 'trace3', endpoint: undefined },
      ] as const;

      await db.insert(apiMetrics).values(metricRows.map((r) => ({ ...r, method: r.method as 'GET' | 'POST' })));
      await db.insert(systemLogs).values(logRows.map((r) => ({ ...r, level: r.level as 'info' | 'warn' | 'error', category: r.category ?? null, metadata: 'metadata' in r ? r.metadata : null })));
      await db.insert(errorLogs).values(errorRows.map((r) => ({ ...r, stack: r.stack ?? null, endpoint: r.endpoint ?? null })));

      const identity = (row: { id: string; timestamp: Date }) => ({ id: row.id, timestamp: row.timestamp });
      await chClient.insert({ table: 'api_metrics', values: metricRows.map((r) => mapApiMetricToRow(r, identity(r))), format: 'JSONEachRow' });
      await chClient.insert({ table: 'system_logs', values: logRows.map((r) => mapSystemLogToRow(r, identity(r))), format: 'JSONEachRow' });
      await chClient.insert({ table: 'error_logs', values: errorRows.map((r) => mapErrorLogToRow(r, identity(r))), format: 'JSONEachRow' });
    }, 30_000);

    afterAll(async () => {
      delete process.env.CLICKHOUSE_ENABLED;
      try {
        await db.delete(apiMetrics).where(like(apiMetrics.id, `${runId}%`));
        await db.delete(systemLogs).where(like(systemLogs.id, `${runId}%`));
        await db.delete(errorLogs).where(like(errorLogs.id, `${runId}%`));
      } catch {
        // best-effort cleanup
      }
      try {
        for (const table of ['api_metrics', 'system_logs', 'error_logs']) {
          await chClient.command({ query: `DELETE FROM ${table} WHERE id LIKE '${runId}%'` });
        }
      } catch {
        // lightweight deletes are best-effort; rows sit in a unique past window
      }
      await chClient?.close();
    }, 30_000);

    it('getSystemHealth: logsByLevel and recentErrors match; active users stay on PG sessions', async () => {
      const pg = await getSystemHealth(WINDOW_START, WINDOW_END);
      const ch = await withClickHouse(() => getSystemHealth(WINDOW_START, WINDOW_END));

      const levels = (r: typeof pg) =>
        r.logsByLevel.map((l) => ({ level: l.level, count: Number(l.count) })).sort(byKey((l) => l.level));
      expect(levels(ch)).toEqual(levels(pg));
      expect(levels(pg)).toEqual([
        { level: 'error', count: 2 },
        { level: 'info', count: 1 },
        { level: 'warn', count: 1 },
      ]);

      const errors = (r: typeof pg) =>
        r.recentErrors.map((e) => ({
          id: e.id,
          timestamp: ms(e.timestamp),
          message: e.message,
          errorName: e.errorName,
          errorMessage: e.errorMessage,
          endpoint: e.endpoint,
          userId: e.userId,
        }));
      expect(errors(ch)).toEqual(errors(pg));
      expect(errors(pg).map((e) => e.id)).toEqual([`${runId}-e3`, `${runId}-e2`, `${runId}-e1`]);
      expect(errors(pg)[1].errorMessage).toBe('bang'); // null stack → message fallback

      // sessions-based count: same PG query in both modes → identical value
      expect(ch.activeUserCount).toBe(pg.activeUserCount);
    });

    it('getApiMetrics: volume, top endpoints, error rate and totals match (feeds the overview route)', async () => {
      const pg = await getApiMetrics(WINDOW_START, WINDOW_END);
      const ch = await withClickHouse(() => getApiMetrics(WINDOW_START, WINDOW_END));

      const volume = (r: typeof pg) =>
        r.volumeOverTime
          .map((v) => ({ hour: ms(v.hour), count: Number(v.count), avg: num(v.avg_response_time) }))
          .sort((a, b) => a.hour - b.hour);
      expect(volume(ch)).toEqual(volume(pg));
      expect(volume(pg)).toEqual([
        { hour: WINDOW_START.getTime(), count: 2, avg: 160 },
        { hour: WINDOW_START.getTime() + 3_600_000, count: 1, avg: 120 },
      ]);

      const top = (r: typeof pg) =>
        r.topEndpoints
          .map((t) => ({ endpoint: t.endpoint, count: Number(t.count), avg: num(t.avgResponseTime) }))
          .sort(byKey((t) => t.endpoint));
      expect(top(ch)).toEqual(top(pg));

      expect(ch.totalRequests).toBe(pg.totalRequests);
      expect(pg.totalRequests).toBe(3);
      expect(num(ch.errorRate)).toEqual(num(pg.errorRate));
      expect(num(pg.errorRate)).toEqual(num(100 / 3));
    });

    it('getErrorAnalytics: trends, patterns and failed logins match — emails masked on BOTH paths', async () => {
      const pg = await getErrorAnalytics(WINDOW_START, WINDOW_END);
      const ch = await withClickHouse(() => getErrorAnalytics(WINDOW_START, WINDOW_END));

      const trends = (r: typeof pg) =>
        r.errorTrends
          .map((t) => ({ hour: ms(t.hour), category: t.category, count: t.count }))
          .sort(byKey((t) => `${t.hour}-${t.category}`));
      expect(trends(ch)).toEqual(trends(pg));
      expect(trends(pg).map((t) => t.category).sort()).toEqual(['auth', 'other']);

      const patterns = (r: typeof pg) =>
        r.errorPatterns
          .map((p) => ({ name: p.name, category: p.category, count: Number(p.count) }))
          .sort(byKey((p) => `${p.name}-${p.category}`));
      expect(patterns(ch)).toEqual(patterns(pg));
      expect(patterns(pg)).toEqual([
        { name: 'RangeError', category: 'general', count: 1 },
        { name: 'TypeError', category: '/api/pages', count: 2 },
      ]);

      const logins = (r: typeof pg) =>
        r.failedLogins.map((l) => ({ timestamp: ms(l.timestamp), ip: l.ip, metadata: l.metadata }));
      expect(logins(ch)).toEqual(logins(pg));
      const serialized = JSON.stringify(logins(pg)) + JSON.stringify(logins(ch));
      expect(serialized).not.toContain('jane@example.com');
      expect(serialized).not.toContain('bob@corp.io');
    });
  },
);
