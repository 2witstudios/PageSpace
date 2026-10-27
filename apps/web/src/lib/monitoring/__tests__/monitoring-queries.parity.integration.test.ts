/**
 * CH-vs-PG parity for the re-pointed web monitoring readers (#890 Phase 3
 * leaf 3) — the acceptance backbone for the read cutover.
 *
 * Both stores are seeded with the SAME logical rows inside a random past
 * time window unique to this run (the readers aggregate globally, so a
 * window nobody else writes into makes the windowed queries deterministic
 * even against a dirty dev database). Each re-pointed reader then runs
 * twice — flag off (PG path, exactly as before this leaf) and flag on (CH
 * path) — and the outputs are compared after normalization (Date→ms,
 * numeric strings→numbers, order-insensitive sorts, float tolerance).
 *
 * The 15-minute active-user count is now-relative and cannot be windowed,
 * so it is asserted as equal DELTAS after seeding fresh distinct users into
 * both stores.
 *
 * Requires DATABASE_URL → migrated Postgres (scripts/test-with-db.sh) AND
 * the dev ClickHouse container (docker compose -f docker-compose.yml -f
 * docker-compose.dev.yml up -d clickhouse). Skips itself when either store
 * is unreachable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { get } from 'node:http';
import {
  getClickHouseClient,
  type ClickHouseClient,
} from '@pagespace/lib/observability/clickhouse-client';
import { db } from '@pagespace/db/db';
import { inArray, like } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import {
  apiMetrics,
  systemLogs,
  userActivities,
  errorLogs,
} from '@pagespace/db/schema/monitoring';
import { factories } from '@pagespace/db/test/factories';
import { ensureAnalyticsTables } from '@pagespace/lib/observability/clickhouse-ddl';
import {
  mapApiMetricToRow,
  mapSystemLogToRow,
  mapUserActivityToRow,
  mapErrorLogToRow,
} from '@pagespace/lib/observability/analytics-rows';
import {
  getSystemHealth,
  getApiMetrics,
  getUserActivity,
  getErrorAnalytics,
  getPerformanceMetrics,
} from '../monitoring-queries';

// PG EXTRACT(HOUR/DOW) buckets in the server's local zone while CH buckets in
// UTC; production runs UTC, so the parity contract (and this test) is UTC.
process.env.TZ = 'UTC';

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_ENV = {
  CLICKHOUSE_ENABLED: 'true',
  CLICKHOUSE_URL: CH_URL,
  CLICKHOUSE_USER: process.env.CLICKHOUSE_USER ?? 'user',
  CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? 'password',
  CLICKHOUSE_DATABASE: process.env.CLICKHOUSE_DATABASE ?? 'pagespace_analytics',
};

// node:http, not fetch — the web test setup stubs the global fetch.
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

// Random PAST hour-aligned window 36–72h ago. It must be RECENT: the CH
// tables carry TTLs (system_logs 30d is the tightest) and ClickHouse drops
// already-expired rows at insert time (optimize_on_insert), so seeding into
// a deep-past window silently inserts nothing. The random 36h offset keeps
// concurrent/successive runs from landing in each other's window.
const WINDOW_START = new Date(
  Math.floor((Date.now() - 72 * 3_600_000) / 3_600_000) * 3_600_000 +
    Math.floor(Math.random() * 36) * 3_600_000,
);
const WINDOW_END = new Date(WINDOW_START.getTime() + 2 * 3_600_000);
const runId = `parity-${WINDOW_START.getTime()}`;
const at = (minutes: number): Date => new Date(WINDOW_START.getTime() + minutes * 60_000);

/** Run fn with the CH read path enabled, restoring the previous env after. */
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

// ── Normalizers (PG returns Dates + numeric strings; CH returns Dates + numbers) ──
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v) * 1e6) / 1e6);
const byKey = <T>(key: (r: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));

let seededUsers: { u1: string; u2: string; ghost: string };
let chClient: ClickHouseClient;
const createdUserIds: string[] = [];

describe.skipIf(!chReachable || !pgReachable)(
  'web monitoring readers: ClickHouse path ≡ Postgres path on identically seeded data',
  () => {
    beforeAll(async () => {
      // Construct the process singleton through the lib accessor — the exact
      // client instance the re-pointed readers will use (apps/web declares no
      // direct @clickhouse/client dependency; server code reaches CH only via
      // @pagespace/lib).
      chClient = (await withClickHouse(async () => getClickHouseClient()))!;
      await ensureAnalyticsTables(chClient);

      const u1 = await factories.createUser();
      const u2 = await factories.createUser();
      createdUserIds.push(u1.id, u2.id);
      seededUsers = { u1: u1.id, u2: u2.id, ghost: `${runId}-ghost` };

      // ── the same logical rows into BOTH stores ─────────────────────────────
      const metricRows = [
        { id: `${runId}-m1`, timestamp: at(5), endpoint: '/api/a', method: 'GET', statusCode: 200, duration: 100 },
        { id: `${runId}-m2`, timestamp: at(10), endpoint: '/api/a', method: 'GET', statusCode: 404, duration: 200 },
        { id: `${runId}-m3`, timestamp: at(65), endpoint: '/api/b', method: 'POST', statusCode: 200, duration: 300 },
        { id: `${runId}-m4`, timestamp: at(70), endpoint: '/api/b', method: 'POST', statusCode: 500, duration: 6000, userId: u1.id },
        { id: `${runId}-m5`, timestamp: at(75), endpoint: '/api/a', method: 'GET', statusCode: 200, duration: 150 },
      ] as const;

      const logRows = [
        { id: `${runId}-s1`, timestamp: at(6), level: 'info', message: 'ok', category: 'api' },
        { id: `${runId}-s2`, timestamp: at(12), level: 'error', message: 'api blew up', category: 'api' },
        { id: `${runId}-s3`, timestamp: at(66), level: 'error', message: 'uncategorized', category: undefined },
        { id: `${runId}-s4`, timestamp: at(68), level: 'warn', message: 'login failed', category: 'auth', ip: '9.9.9.9', metadata: { detail: 'login failed for jane@example.com' } },
        { id: `${runId}-s5`, timestamp: at(69), level: 'error', message: 'lockout', category: 'auth', metadata: { attempts: 5 } },
      ] as const;

      const activityRows = [
        { id: `${runId}-a1`, timestamp: at(7), userId: u1.id, action: 'create' },
        { id: `${runId}-a2`, timestamp: at(8), userId: u1.id, action: 'create' },
        { id: `${runId}-a3`, timestamp: at(9), userId: u1.id, action: 'update' },
        { id: `${runId}-a4`, timestamp: at(64), userId: u2.id, action: 'update' },
        // Deleted user: activities survive, users row does not — both paths must drop
        // it from mostActiveUsers but keep it in the heatmap/feature aggregates.
        { id: `${runId}-a5`, timestamp: at(11), userId: seededUsers.ghost, action: 'delete' },
        { id: `${runId}-a6`, timestamp: at(13), userId: seededUsers.ghost, action: 'delete' },
      ] as const;

      const errorRows = [
        { id: `${runId}-e1`, timestamp: at(15), name: 'TypeError', message: 'boom', stack: 'trace1', endpoint: '/api/a', userId: u1.id },
        { id: `${runId}-e2`, timestamp: at(20), name: 'TypeError', message: 'bang', stack: undefined, endpoint: '/api/a' },
        { id: `${runId}-e3`, timestamp: at(67), name: 'RangeError', message: 'oops', stack: 'trace3', endpoint: undefined },
      ] as const;

      await db.insert(apiMetrics).values(metricRows.map((r) => ({ ...r, method: r.method as 'GET' | 'POST' })));
      await db.insert(systemLogs).values(logRows.map((r) => ({ ...r, level: r.level as 'info' | 'warn' | 'error', category: r.category ?? null, metadata: 'metadata' in r ? r.metadata : null })));
      await db.insert(userActivities).values([...activityRows]);
      await db.insert(errorLogs).values(errorRows.map((r) => ({ ...r, stack: r.stack ?? null, endpoint: r.endpoint ?? null })));

      const identity = (row: { id: string; timestamp: Date }) => ({ id: row.id, timestamp: row.timestamp });
      await chClient.insert({ table: 'api_metrics', values: metricRows.map((r) => mapApiMetricToRow(r, identity(r))), format: 'JSONEachRow' });
      await chClient.insert({ table: 'system_logs', values: logRows.map((r) => mapSystemLogToRow(r, identity(r))), format: 'JSONEachRow' });
      await chClient.insert({ table: 'user_activities', values: activityRows.map((r) => mapUserActivityToRow(r, identity(r))), format: 'JSONEachRow' });
      await chClient.insert({ table: 'error_logs', values: errorRows.map((r) => mapErrorLogToRow(r, identity(r))), format: 'JSONEachRow' });
    }, 30_000);

    afterAll(async () => {
      delete process.env.CLICKHOUSE_ENABLED;
      try {
        await db.delete(apiMetrics).where(like(apiMetrics.id, `${runId}%`));
        await db.delete(systemLogs).where(like(systemLogs.id, `${runId}%`));
        await db.delete(userActivities).where(like(userActivities.id, `${runId}%`));
        await db.delete(errorLogs).where(like(errorLogs.id, `${runId}%`));
        if (createdUserIds.length) {
          await db.delete(userActivities).where(inArray(userActivities.userId, createdUserIds));
          await db.delete(users).where(inArray(users.id, createdUserIds));
        }
      } catch {
        // best-effort cleanup
      }
      try {
        for (const table of ['api_metrics', 'system_logs', 'user_activities', 'error_logs']) {
          await chClient.command({ query: `DELETE FROM ${table} WHERE id LIKE '${runId}%'` });
        }
      } catch {
        // lightweight deletes are best-effort; rows sit in a unique past window
      }
      await chClient?.close();
    }, 30_000);

    it('getSystemHealth: logsByLevel and recentErrors match', async () => {
      const pg = await getSystemHealth(WINDOW_START, WINDOW_END);
      const ch = await withClickHouse(() => getSystemHealth(WINDOW_START, WINDOW_END));

      const levels = (r: typeof pg) =>
        r.logsByLevel.map((l) => ({ level: l.level, count: Number(l.count) })).sort(byKey((l) => l.level));
      expect(levels(ch)).toEqual(levels(pg));
      expect(levels(pg)).toEqual([
        { level: 'error', count: 3 },
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
      // stack-null row falls back to message in both paths
      expect(errors(pg)[1].errorMessage).toBe('bang');
    });

    it('getSystemHealth: the 15-minute active-user count moves by the same delta in both stores', async () => {
      const freshA = `${runId}-fresh-a`;
      const freshB = `${runId}-fresh-b`;
      const now = new Date();

      const pgBefore = (await getSystemHealth(WINDOW_START, WINDOW_END)).activeUserCount;
      await db.insert(userActivities).values([
        { id: `${runId}-recent-1`, timestamp: now, userId: freshA, action: 'parity_probe' },
        { id: `${runId}-recent-2`, timestamp: now, userId: freshB, action: 'parity_probe' },
      ]);
      const pgAfter = (await getSystemHealth(WINDOW_START, WINDOW_END)).activeUserCount;
      expect(pgAfter - pgBefore).toBe(2);

      const chBefore = await withClickHouse(async () => (await getSystemHealth(WINDOW_START, WINDOW_END)).activeUserCount);
      await chClient.insert({
        table: 'user_activities',
        values: [
          mapUserActivityToRow({ userId: freshA, action: 'parity_probe' }, { id: `${runId}-recent-1`, timestamp: now }),
          mapUserActivityToRow({ userId: freshB, action: 'parity_probe' }, { id: `${runId}-recent-2`, timestamp: now }),
        ],
        format: 'JSONEachRow',
      });
      const chAfter = await withClickHouse(async () => (await getSystemHealth(WINDOW_START, WINDOW_END)).activeUserCount);
      expect(chAfter - chBefore).toBe(2);
    });

    it('getApiMetrics: volume, top endpoints, error rate and totals match', async () => {
      const pg = await getApiMetrics(WINDOW_START, WINDOW_END);
      const ch = await withClickHouse(() => getApiMetrics(WINDOW_START, WINDOW_END));

      const volume = (r: typeof pg) =>
        r.volumeOverTime
          .map((v) => ({ hour: ms(v.hour), count: Number(v.count), avg: num(v.avg_response_time) }))
          .sort((a, b) => a.hour - b.hour);
      expect(volume(ch)).toEqual(volume(pg));
      expect(volume(pg).map((v) => v.count)).toEqual([2, 3]);

      const top = (r: typeof pg) =>
        r.topEndpoints
          .map((t) => ({ endpoint: t.endpoint, count: Number(t.count), avg: num(t.avgResponseTime) }))
          .sort(byKey((t) => t.endpoint));
      expect(top(ch)).toEqual(top(pg));
      expect(top(pg)).toEqual([
        { endpoint: '/api/a', count: 3, avg: 150 },
        { endpoint: '/api/b', count: 2, avg: 3150 },
      ]);

      expect(ch.totalRequests).toBe(pg.totalRequests);
      expect(pg.totalRequests).toBe(5);
      expect(num(ch.errorRate)).toEqual(num(pg.errorRate));
      expect(pg.errorRate).toBe(40);
    });

    it('getUserActivity: heatmap, most-active (two-step join) and feature usage match', async () => {
      const pg = await getUserActivity(WINDOW_START, WINDOW_END);
      const ch = await withClickHouse(() => getUserActivity(WINDOW_START, WINDOW_END));

      const heatmap = (r: typeof pg) =>
        r.heatmapData
          .map((h) => ({ dow: Number(h.day_of_week), hour: Number(h.hour_of_day), count: Number(h.activity_count) }))
          .sort(byKey((h) => `${h.dow}-${h.hour}`));
      expect(heatmap(ch)).toEqual(heatmap(pg));
      expect(heatmap(pg).reduce((sum, h) => sum + h.count, 0)).toBe(6); // ghost rows included

      const active = (r: typeof pg) =>
        r.mostActiveUsers.map((u) => ({ userId: u.userId, userName: u.userName, actionCount: Number(u.actionCount) }));
      expect(active(ch)).toEqual(active(pg));
      // the users INNER JOIN (PG) and the two-step lookup (CH) both drop the ghost
      expect(active(pg).map((u) => u.userId)).toEqual([seededUsers.u1, seededUsers.u2]);
      expect(active(pg).map((u) => u.actionCount)).toEqual([3, 1]);

      const usage = (r: typeof pg) =>
        r.featureUsage.map((f) => ({ action: f.action, count: Number(f.count) })).sort(byKey((f) => f.action));
      expect(usage(ch)).toEqual(usage(pg));
      expect(usage(pg)).toEqual([
        { action: 'create', count: 2 },
        { action: 'delete', count: 2 },
        { action: 'update', count: 2 },
      ]);
    });

    it('getErrorAnalytics: trends (null→other), patterns and failed logins match', async () => {
      const pg = await getErrorAnalytics(WINDOW_START, WINDOW_END);
      const ch = await withClickHouse(() => getErrorAnalytics(WINDOW_START, WINDOW_END));

      const trends = (r: typeof pg) =>
        r.errorTrends
          .map((t) => ({ hour: ms(t.hour), category: t.category, count: t.count }))
          .sort(byKey((t) => `${t.hour}-${t.category}`));
      expect(trends(ch)).toEqual(trends(pg));
      expect(trends(pg).map((t) => t.category).sort()).toEqual(['api', 'auth', 'other']);

      const patterns = (r: typeof pg) =>
        r.errorPatterns
          .map((p) => ({ name: p.name, category: p.category, count: Number(p.count) }))
          .sort(byKey((p) => `${p.name}-${p.category}`));
      expect(patterns(ch)).toEqual(patterns(pg));
      expect(patterns(pg)).toEqual([
        { name: 'RangeError', category: 'general', count: 1 },
        { name: 'TypeError', category: '/api/a', count: 2 },
      ]);

      const logins = (r: typeof pg) =>
        r.failedLogins.map((l) => ({ timestamp: ms(l.timestamp), ip: l.ip, metadata: l.metadata }));
      expect(logins(ch)).toEqual(logins(pg));
      expect(logins(pg).map((l) => l.ip)).toEqual([null, '9.9.9.9']);
    });

    it('getPerformanceMetrics: response times, slow queries and per-endpoint stats match', async () => {
      const pg = await getPerformanceMetrics(WINDOW_START, WINDOW_END);
      const ch = await withClickHouse(() => getPerformanceMetrics(WINDOW_START, WINDOW_END));

      const times = (r: typeof pg) =>
        r.responseTimes
          .map((t) => ({
            hour: ms(t.hour),
            avg: num(t.avg_response_time),
            max: num(t.max_response_time),
            min: num(t.min_response_time),
          }))
          .sort((a, b) => a.hour - b.hour);
      expect(times(ch)).toEqual(times(pg));
      expect(times(pg)).toEqual([
        { hour: WINDOW_START.getTime(), avg: 150, max: 200, min: 100 },
        { hour: WINDOW_START.getTime() + 3_600_000, avg: 2150, max: 6000, min: 150 },
      ]);

      const slow = (r: typeof pg) =>
        r.slowQueries.map((s) => ({
          endpoint: s.endpoint,
          responseTime: Number(s.responseTime),
          timestamp: ms(s.timestamp),
          userId: s.userId,
        }));
      expect(slow(ch)).toEqual(slow(pg));
      expect(slow(pg)).toEqual([
        { endpoint: '/api/b', responseTime: 6000, timestamp: at(70).getTime(), userId: seededUsers.u1 },
      ]);

      const perEndpoint = (r: typeof pg) =>
        r.metricTypes
          .map((m) => ({ metric: m.metric, avg: num(m.avgValue), count: Number(m.count) }))
          .sort(byKey((m) => m.metric));
      expect(perEndpoint(ch)).toEqual(perEndpoint(pg));
      expect(perEndpoint(pg)).toEqual([
        { metric: '/api/a', avg: 150, count: 3 },
        { metric: '/api/b', avg: 3150, count: 2 },
      ]);
    });
  },
);
