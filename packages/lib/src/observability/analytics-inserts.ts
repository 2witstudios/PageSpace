/**
 * ClickHouse insert adapters for the 4 analytics tables (#890 Phase 3 leaf 2).
 *
 * Each adapter is (row) → void: it maps the PG-shaped write to a CH row (pure,
 * analytics-rows.ts) and hands it to that table's buffer
 * (clickhouse-buffer.ts). No DB access happens inside the call — the buffer
 * flushes asynchronously — so the request path never blocks on ClickHouse.
 *
 * Never-throw contract: a misconfigured client, an unreachable server, or
 * unserializable metadata drops the row and logs a payload-free message
 * (table name + error only — rows can carry PII). Analytics rows are
 * droppable; requests are not.
 */

import { createId } from '@paralleldrive/cuid2';
import {
  createClickHouseBuffer,
  type ClickHouseBuffer,
} from './clickhouse-buffer';
import { getClickHouseClient } from './clickhouse-client';
import { ClickHouseMisconfiguredError } from './clickhouse-env';
import {
  ANALYTICS_TABLES,
  mapApiMetricToRow,
  mapErrorLogToRow,
  mapSystemLogToRow,
  mapUserActivityToRow,
  type AnalyticsTable,
  type ApiMetricWrite,
  type AssignedRowIdentity,
  type ErrorLogWrite,
  type SystemLogWrite,
  type UserActivityWrite,
} from './analytics-rows';

export type {
  ApiMetricWrite,
  SystemLogWrite,
  UserActivityWrite,
  ErrorLogWrite,
} from './analytics-rows';

/** Structural slice of ClickHouseClient — the adapters need only insert(). */
export interface AnalyticsInsertClient {
  insert: (params: {
    table: string;
    values: Record<string, unknown>[];
    format: 'JSONEachRow';
  }) => Promise<unknown>;
}

export interface AnalyticsInsertersDeps {
  /** Returns null when the tier is off; may throw when misconfigured (absorbed). */
  getClient: () => AnalyticsInsertClient | null;
  createId?: () => string;
  now?: () => Date;
  /** Receives payload-free messages on dropped rows/batches. Defaults to console.error. */
  logError?: (message: string) => void;
  maxRows?: number;
  flushIntervalMs?: number;
}

export interface AnalyticsInserters {
  insertApiMetric: (row: ApiMetricWrite) => void;
  insertSystemLog: (row: SystemLogWrite) => void;
  insertUserActivity: (row: UserActivityWrite) => void;
  insertError: (row: ErrorLogWrite) => void;
  /** Flush all table buffers now (tests, opportunistic). Never rejects. */
  flush: () => Promise<void>;
  /** Flush and await in-flight inserts (shutdown path). Never rejects. */
  drain: () => Promise<void>;
}

export function createAnalyticsInserters(deps: AnalyticsInsertersDeps): AnalyticsInserters {
  const generateId = deps.createId ?? createId;
  const now = deps.now ?? (() => new Date());
  const logError = deps.logError ?? ((message: string) => console.error(message));

  // One buffer per table, created on first use — importing this module (or
  // creating the inserters) touches neither the client nor the env.
  const buffers = new Map<AnalyticsTable, ClickHouseBuffer<Record<string, unknown>>>();

  const getBuffer = (table: AnalyticsTable): ClickHouseBuffer<Record<string, unknown>> | null => {
    const existing = buffers.get(table);
    if (existing) return existing;

    const client = deps.getClient();
    if (!client) return null;

    const buffer = createClickHouseBuffer<Record<string, unknown>>(table, {
      insert: async ({ table: t, values }) => {
        await client.insert({ table: t, values, format: 'JSONEachRow' });
      },
      maxRows: deps.maxRows,
      flushIntervalMs: deps.flushIntervalMs,
      logError,
    });
    buffers.set(table, buffer);
    return buffer;
  };

  // buildRow runs inside the try so mapping failures (e.g. circular metadata)
  // are absorbed like client failures: drop + payload-free log.
  const enqueue = (table: AnalyticsTable, buildRow: () => Record<string, unknown>): void => {
    try {
      const buffer = getBuffer(table);
      if (!buffer) return;
      buffer.insert(buildRow());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A misconfigured deploy is not a transient drop — the startup probe
      // (probeClickHouseStartup at each composition root) should have crashed
      // this process; name the state so it can never read as routine noise.
      logError(
        error instanceof ClickHouseMisconfiguredError
          ? `analytics-inserts: MISCONFIGURED ClickHouse — dropping "${table}" rows; the startup probe should have crashed this process: ${message}`
          : `analytics-inserts: dropped a "${table}" row: ${message}`,
      );
    }
  };

  const assign = (id: string | undefined, timestamp: Date | undefined): AssignedRowIdentity => ({
    id: id ?? generateId(),
    timestamp: timestamp ?? now(),
  });

  return {
    insertApiMetric(row: ApiMetricWrite): void {
      enqueue(ANALYTICS_TABLES.apiMetrics, () =>
        mapApiMetricToRow(row, assign(row.id, row.timestamp)));
    },
    insertSystemLog(row: SystemLogWrite): void {
      enqueue(ANALYTICS_TABLES.systemLogs, () =>
        mapSystemLogToRow(row, assign(row.id, row.timestamp)));
    },
    insertUserActivity(row: UserActivityWrite): void {
      enqueue(ANALYTICS_TABLES.userActivities, () =>
        mapUserActivityToRow(row, assign(row.id, row.timestamp)));
    },
    insertError(row: ErrorLogWrite): void {
      enqueue(ANALYTICS_TABLES.errorLogs, () =>
        mapErrorLogToRow(row, assign(row.id, row.timestamp)));
    },
    async flush(): Promise<void> {
      await Promise.all([...buffers.values()].map((buffer) => buffer.flush()));
    },
    async drain(): Promise<void> {
      await Promise.all([...buffers.values()].map((buffer) => buffer.drain()));
    },
  };
}

// Per-process default instance wired to the lazy client shell — the writers in
// logging/logger-database.ts (and the web write sites) import these directly.
const defaultInserters = createAnalyticsInserters({ getClient: getClickHouseClient });

export const insertApiMetric = (row: ApiMetricWrite): void =>
  defaultInserters.insertApiMetric(row);
export const insertSystemLog = (row: SystemLogWrite): void =>
  defaultInserters.insertSystemLog(row);
export const insertUserActivity = (row: UserActivityWrite): void =>
  defaultInserters.insertUserActivity(row);
export const insertError = (row: ErrorLogWrite): void =>
  defaultInserters.insertError(row);

/** Flush the default buffers (opportunistic; never rejects). */
export const flushAnalyticsInserts = (): Promise<void> => defaultInserters.flush();
/** Drain the default buffers on shutdown (never rejects). */
export const drainAnalyticsInserts = (): Promise<void> => defaultInserters.drain();
