/**
 * createClickHouseBuffer — pure buffered-insert factory for the ClickHouse
 * analytics tier (#890 Phase 3). One instance per table, created at app
 * startup; the insert adapters (Phase 3 leaf 2) stay pure (row) → void.
 *
 * Contract (design ref vzt8ufpdu6pvvorg6bxniswn):
 * - No module-level state — everything lives in the factory closure.
 * - Auto-flush at maxRows (500) OR flushIntervalMs (1000ms), whichever first.
 * - insert()/flush() NEVER throw and never block the request path; a failed
 *   flush discards its batch (analytics rows are droppable, requests are not).
 * - Flush errors log the table name + error message but NEVER row payloads (PII).
 * - Concurrent insert() during an in-flight flush lands in a fresh batch
 *   (double-buffer swap) — it never blocks and is never swallowed.
 * - drain() flushes remaining rows and awaits all in-flight flushes before
 *   resolving — the SIGTERM/SIGINT shutdown path.
 */

export const DEFAULT_MAX_ROWS = 500;
export const DEFAULT_FLUSH_INTERVAL_MS = 1000;

/** Thin seam over @clickhouse/client's insert — injected, never imported here. */
export type ClickHouseInsertFn<Row> = (params: {
  table: string;
  values: Row[];
}) => Promise<void>;

export interface ClickHouseBufferOpts<Row> {
  insert: ClickHouseInsertFn<Row>;
  maxRows?: number;
  flushIntervalMs?: number;
  /** Receives a payload-free message on flush failure. Defaults to console.error. */
  logError?: (message: string) => void;
}

export interface ClickHouseBuffer<Row> {
  /** Buffer a row; may trigger an async auto-flush. Never throws, never blocks. */
  insert: (row: Row) => void;
  /** Flush pending rows now. Always resolves — flush failures are logged, not thrown. */
  flush: () => Promise<void>;
  /** Flush pending rows and await every in-flight flush (shutdown path). */
  drain: () => Promise<void>;
  /** Rows currently buffered (excludes batches already in flight). */
  pendingCount: () => number;
}

export function createClickHouseBuffer<Row>(
  table: string,
  opts: ClickHouseBufferOpts<Row>,
): ClickHouseBuffer<Row> {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const logError = opts.logError ?? ((message: string) => console.error(message));

  let rows: Row[] = [];
  let timer: NodeJS.Timeout | null = null;
  const inFlight = new Set<Promise<void>>();

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = (): Promise<void> => {
    clearTimer();
    if (rows.length === 0) return Promise.resolve();

    // Double-buffer swap: concurrent insert() calls land in the fresh array.
    const batch = rows;
    rows = [];

    // The batch is discarded on failure (never retried) and MUST NOT be
    // logged — rows can carry PII. Table name + count + error message only.
    const logFailure = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      logError(
        `clickhouse-buffer: flush failed for table "${table}", dropping batch of ${batch.length}: ${message}`,
      );
    };

    // Invoke the client synchronously (the batch is handed off before flush()
    // returns); a synchronously-throwing insert is absorbed the same as a
    // rejected one.
    let started: Promise<void>;
    try {
      started = opts.insert({ table, values: batch });
    } catch (error) {
      logFailure(error);
      return Promise.resolve();
    }

    const attempt: Promise<void> = started.catch(logFailure).finally(() => {
      inFlight.delete(attempt);
    });
    inFlight.add(attempt);
    return attempt;
  };

  const scheduleFlush = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
    // A pending analytics flush must not hold the process open; drain() is the
    // deliberate shutdown path. Guarded: fake timers may lack unref.
    timer.unref?.();
  };

  return {
    insert(row: Row): void {
      rows.push(row);
      if (rows.length >= maxRows) {
        void flush();
        return;
      }
      scheduleFlush();
    },
    flush,
    async drain(): Promise<void> {
      await flush();
      await Promise.all([...inFlight]);
    },
    pendingCount: () => rows.length,
  };
}
