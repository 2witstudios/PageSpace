/**
 * error_resolutions workflow against the REAL stores (#890 Phase 3 leaf 3).
 *
 * Proves the acceptance path end to end: the resolve action upserts the
 * error_resolutions mini-table in main PG (migration 0194), and the
 * two-step reader merges resolution state onto error rows fetched from
 * whichever store is live — PG with the flag off, ClickHouse with it on —
 * with identical merged output on identically seeded data. The two stores
 * are never SQL-joined.
 *
 * Requires DATABASE_URL → migrated Postgres; the CH half additionally needs
 * the dev ClickHouse container and is skipped without it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { get } from 'node:http';
import { db } from '@pagespace/db/db';
import { like, inArray } from '@pagespace/db/operators';
import { errorLogs, errorResolutions } from '@pagespace/db/schema/monitoring';
import { getClickHouseClient, type ClickHouseClient } from '../clickhouse-client';
import { ensureAnalyticsTables } from '../clickhouse-ddl';
import { mapErrorLogToRow } from '../analytics-rows';
import {
  setErrorResolution,
  fetchErrorResolutions,
  listRecentErrorsWithResolutions,
} from '../error-resolutions';

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_ENV = {
  CLICKHOUSE_ENABLED: 'true',
  CLICKHOUSE_URL: CH_URL,
  CLICKHOUSE_USER: process.env.CLICKHOUSE_USER ?? 'user',
  CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? 'password',
  CLICKHOUSE_DATABASE: process.env.CLICKHOUSE_DATABASE ?? 'pagespace_analytics',
};

// node:http, not fetch — the lib test setup stubs the global fetch.
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
    await db.select({ errorId: errorResolutions.errorId }).from(errorResolutions).limit(1);
    return true;
  } catch {
    return false;
  }
})();

// Hour-aligned random window 36–72h back: inside every CH TTL (expired rows
// are dropped at insert time), in the past, and unique enough per run.
const WINDOW_START = new Date(
  Math.floor((Date.now() - 72 * 3_600_000) / 3_600_000) * 3_600_000 +
    Math.floor(Math.random() * 36) * 3_600_000,
);
const WINDOW = {
  startDate: WINDOW_START,
  endDate: new Date(WINDOW_START.getTime() + 3_600_000),
};
const runId = `errres-${WINDOW_START.getTime()}-${Math.floor(Math.random() * 1e6)}`;
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

const errorRows = [
  { id: `${runId}-e1`, timestamp: at(5), name: 'TypeError', message: 'boom', stack: 'trace1', endpoint: '/api/x' },
  { id: `${runId}-e2`, timestamp: at(10), name: 'RangeError', message: 'bang' },
] as const;

let chClient: ClickHouseClient | null = null;

describe.skipIf(!pgReachable)('error resolution workflow (real Postgres, optional ClickHouse)', () => {
  beforeAll(async () => {
    await db.insert(errorLogs).values(errorRows.map((r) => ({
      ...r,
      stack: 'stack' in r ? r.stack : null,
      endpoint: 'endpoint' in r ? r.endpoint : null,
    })));
    if (chReachable) {
      chClient = (await withClickHouse(async () => getClickHouseClient()))!;
      await ensureAnalyticsTables(chClient);
      await chClient.insert({
        table: 'error_logs',
        values: errorRows.map((r) => mapErrorLogToRow(r, { id: r.id, timestamp: r.timestamp })),
        format: 'JSONEachRow',
      });
    }
  }, 30_000);

  afterAll(async () => {
    delete process.env.CLICKHOUSE_ENABLED;
    try {
      await db.delete(errorResolutions).where(like(errorResolutions.errorId, `${runId}%`));
      await db.delete(errorLogs).where(like(errorLogs.id, `${runId}%`));
    } catch {
      // best-effort cleanup
    }
    try {
      await chClient?.command({ query: `DELETE FROM error_logs WHERE id LIKE '${runId}%'` });
    } catch {
      // lightweight deletes are best-effort
    }
    await chClient?.close();
  }, 30_000);

  it('given a resolve action, should upsert exactly one PG row and update it on re-resolve (reopen)', async () => {
    await setErrorResolution({ errorId: `${runId}-e1`, resolvedBy: 'admin-1', resolution: 'fixed' });
    let rows = await fetchErrorResolutions([`${runId}-e1`]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ errorId: `${runId}-e1`, resolved: true, resolvedBy: 'admin-1', resolution: 'fixed' });

    await setErrorResolution({ errorId: `${runId}-e1`, resolved: false, resolvedBy: 'admin-2', resolution: 'still happening' });
    rows = await fetchErrorResolutions([`${runId}-e1`]);
    expect(rows).toHaveLength(1); // updated in place, not duplicated
    expect(rows[0]).toMatchObject({ resolved: false, resolvedBy: 'admin-2', resolution: 'still happening' });

    const [{ count }] = await db
      .select({ count: errorResolutions.errorId })
      .from(errorResolutions)
      .where(inArray(errorResolutions.errorId, [`${runId}-e1`]))
      .then((r) => [{ count: r.length }]);
    expect(count).toBe(1);
  });

  it('given the flag off, should merge PG error rows with PG resolutions', async () => {
    await setErrorResolution({ errorId: `${runId}-e1`, resolvedBy: 'admin-1', resolution: 'fixed' });
    const merged = await listRecentErrorsWithResolutions(WINDOW, 20);
    const mine = merged.filter((e) => e.id.startsWith(runId));

    expect(mine.map((e) => e.id)).toEqual([`${runId}-e2`, `${runId}-e1`]); // timestamp desc
    expect(mine[1]).toMatchObject({ resolved: true, resolvedBy: 'admin-1', resolution: 'fixed' });
    expect(mine[0]).toMatchObject({ resolved: false, resolvedAt: null, resolvedBy: null, resolution: null });
  });

  it.skipIf(!chReachable)(
    'given the flag on, should fetch errors from CH, resolutions from PG, and merge to the same output',
    async () => {
      await setErrorResolution({ errorId: `${runId}-e1`, resolvedBy: 'admin-1', resolution: 'fixed' });
      const pgMerged = (await listRecentErrorsWithResolutions(WINDOW, 20)).filter((e) => e.id.startsWith(runId));
      const chMerged = (await withClickHouse(() => listRecentErrorsWithResolutions(WINDOW, 20))).filter((e) =>
        e.id.startsWith(runId),
      );

      const normalize = (rows: typeof pgMerged) =>
        rows.map((e) => ({
          ...e,
          timestamp: e.timestamp.getTime(),
          resolvedAt: e.resolvedAt?.getTime() ?? null,
        }));
      expect(normalize(chMerged)).toEqual(normalize(pgMerged));
      expect(chMerged[1].resolved).toBe(true);
    },
  );
});
