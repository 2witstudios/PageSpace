/**
 * Error resolution workflow (#890 Phase 3 leaf 3).
 *
 * Post-cutover, error_logs rows live in immutable ClickHouse — a mutable
 * resolved flag cannot live on them. The workflow state (resolved,
 * resolvedBy, resolvedAt, notes) lives in the error_resolutions mini-table
 * in MAIN PG, keyed by the error row's stable id (the same id space whether
 * the row came from CH or the legacy PG table).
 *
 * The two stores are never SQL-joined. Reads are two-step, merged in app
 * code: fetch error rows from their store → fetch resolutions by id from PG
 * → mergeErrorResolutions. Writes (the resolve action) target ONLY PG.
 * This is the same cross-store join pattern Phase 5 will use for
 * activity_logs.
 */
import { db } from '@pagespace/db/db';
import { errorLogs, errorResolutions } from '@pagespace/db/schema/monitoring';
import { and, desc, gte, inArray, lte } from '@pagespace/db/operators';
import type { SQL } from '@pagespace/db/operators';
import { getClickHouseClient, isClickHouseEnabled } from './clickhouse-client';
import { getRecentErrors } from './analytics-reads';
import type { RecentErrorRow, TimeWindow } from './analytics-read-core';

export interface ErrorResolutionRecord {
  errorId: string;
  resolved: boolean;
  resolvedAt: Date;
  resolvedBy: string | null;
  resolution: string | null;
}

export interface ErrorResolutionInput {
  errorId: string;
  resolved?: boolean;
  resolvedBy?: string | null;
  resolution?: string | null;
}

export type ResolutionFields = {
  resolved: boolean;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolution: string | null;
};

// ── Pure core ────────────────────────────────────────────────────────────────

/** Fill defaults for an upsert: resolving is the default action, reopen is explicit. */
export const normalizeResolutionInput = (
  input: ErrorResolutionInput,
  now: Date,
): ErrorResolutionRecord => ({
  errorId: input.errorId,
  resolved: input.resolved ?? true,
  resolvedAt: now,
  resolvedBy: input.resolvedBy ?? null,
  resolution: input.resolution ?? null,
});

/**
 * Attach resolution state to error rows by id. Errors without a resolution
 * row are unresolved; resolution rows matching no error are dropped.
 */
export const mergeErrorResolutions = <E extends { id: string }>(
  errors: readonly E[],
  resolutions: readonly ErrorResolutionRecord[],
): Array<E & ResolutionFields> => {
  const byId = new Map(resolutions.map((r) => [r.errorId, r]));
  return errors.map((error) => {
    const match = byId.get(error.id);
    return {
      ...error,
      resolved: match?.resolved ?? false,
      resolvedAt: match?.resolvedAt ?? null,
      resolvedBy: match?.resolvedBy ?? null,
      resolution: match?.resolution ?? null,
    };
  });
};

export interface ErrorResolutionReaderDeps<E extends { id: string }> {
  fetchErrors: (window: TimeWindow, limit: number) => Promise<E[]>;
  fetchResolutions: (errorIds: string[]) => Promise<ErrorResolutionRecord[]>;
}

/** Two-step cross-store reader: errors from their store, resolutions from PG, merged here. */
export const createErrorResolutionReader =
  <E extends { id: string }>(deps: ErrorResolutionReaderDeps<E>) =>
  async (window: TimeWindow, limit: number): Promise<Array<E & ResolutionFields>> => {
    const errors = await deps.fetchErrors(window, limit);
    if (errors.length === 0) return [];
    const resolutions = await deps.fetchResolutions(errors.map((e) => e.id));
    return mergeErrorResolutions(errors, resolutions);
  };

// ── PG shells ────────────────────────────────────────────────────────────────

/** The resolve action: upsert the workflow row in main PG (never touches CH). */
export async function setErrorResolution(input: ErrorResolutionInput): Promise<ErrorResolutionRecord> {
  const record = normalizeResolutionInput(input, new Date());
  await db
    .insert(errorResolutions)
    .values(record)
    .onConflictDoUpdate({
      target: errorResolutions.errorId,
      set: {
        resolved: record.resolved,
        resolvedAt: record.resolvedAt,
        resolvedBy: record.resolvedBy,
        resolution: record.resolution,
      },
    });
  return record;
}

export async function fetchErrorResolutions(errorIds: string[]): Promise<ErrorResolutionRecord[]> {
  if (errorIds.length === 0) return [];
  return db
    .select({
      errorId: errorResolutions.errorId,
      resolved: errorResolutions.resolved,
      resolvedAt: errorResolutions.resolvedAt,
      resolvedBy: errorResolutions.resolvedBy,
      resolution: errorResolutions.resolution,
    })
    .from(errorResolutions)
    .where(inArray(errorResolutions.errorId, errorIds));
}

/** Error rows from whichever store is live: CH when enabled, else main PG. */
export async function fetchRecentErrors(
  window: TimeWindow,
  limit: number,
): Promise<RecentErrorRow[]> {
  if (isClickHouseEnabled()) {
    const client = getClickHouseClient();
    if (client) return getRecentErrors(client, window, limit);
  }
  const conditions: SQL[] = [];
  if (window.startDate) conditions.push(gte(errorLogs.timestamp, window.startDate));
  if (window.endDate) conditions.push(lte(errorLogs.timestamp, window.endDate));
  return db
    .select({
      id: errorLogs.id,
      timestamp: errorLogs.timestamp,
      message: errorLogs.message,
      errorName: errorLogs.name,
      errorMessage: errorLogs.stack,
      endpoint: errorLogs.endpoint,
      userId: errorLogs.userId,
    })
    .from(errorLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(errorLogs.timestamp))
    .limit(limit);
}

/**
 * The error-analytics read path with resolution state attached — the
 * canonical replacement for reading error_logs.resolved* columns directly.
 */
export const listRecentErrorsWithResolutions = (
  window: TimeWindow,
  limit = 20,
): Promise<Array<RecentErrorRow & ResolutionFields>> =>
  createErrorResolutionReader({
    fetchErrors: fetchRecentErrors,
    fetchResolutions: fetchErrorResolutions,
  })(window, limit);
