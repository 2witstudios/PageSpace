/**
 * activity_logs hot→cold tiering writer.
 *
 * Flips `isArchived = true` on activity_logs rows older than a configurable
 * threshold so the active-view filter (`isArchived = false`) narrows over time
 * and hot-path query cost stays bounded as the table grows.
 *
 * This is a flag flip ONLY. It never deletes rows and never touches the
 * tamper-evident hash chain (`previousLogHash`, `logHash`, `chainSeed`,
 * `chainSeq`) or rollback provenance — so chain verification is unaffected
 * (`isArchived` is not a hash input; see hash-chain-verifier / computeLogHash).
 *
 * Pure core (config parsing + loop control) is exhaustively testable; the only
 * side effect is the batched DB read/update at the `archiveActivityLogs` edge,
 * which takes an injected `database` handle.
 */

import { and, lt, eq, inArray, asc } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { activityLogs } from '@pagespace/db/schema/monitoring';

const DEFAULT_ARCHIVE_DAYS = 365;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_RUN_MS = 25000;

type DB = NodePgDatabase<Record<string, unknown>>;

export interface ActivityLogArchivalConfig {
  archiveDays: number;
  batchSize: number;
  maxRunMs: number;
}

export interface ArchiveActivityLogsResult {
  table: 'activity_logs';
  archived: number;
  batches: number;
}

export interface ArchiveActivityLogsOptions {
  archiveDays: number;
  batchSize: number;
  maxRunMs: number;
  /** Reference "now" for cutoff computation. Defaults to the wall clock. */
  now?: Date;
  /** Monotonic millisecond source for the per-run wall-clock budget. Injected for tests. */
  clock?: () => number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Read the archival config from the environment. Each field falls back to its
 * default for unset / zero / negative / non-numeric values.
 */
export function getActivityLogArchivalConfig(): ActivityLogArchivalConfig {
  return {
    archiveDays: parsePositiveInt(process.env.ACTIVITY_LOGS_ARCHIVE_DAYS, DEFAULT_ARCHIVE_DAYS),
    batchSize: parsePositiveInt(process.env.ACTIVITY_LOGS_ARCHIVE_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    maxRunMs: parsePositiveInt(process.env.ACTIVITY_LOGS_ARCHIVE_MAX_RUN_MS, DEFAULT_MAX_RUN_MS),
  };
}

/**
 * Pure loop-control predicate: stop when the last batch drained the eligible
 * set (`lastBatchSize < batchSize`) or the per-run wall-clock budget is spent.
 */
export function shouldContinueArchiving(params: {
  lastBatchSize: number;
  batchSize: number;
  elapsedMs: number;
  maxRunMs: number;
}): boolean {
  if (params.lastBatchSize < params.batchSize) return false;
  if (params.elapsedMs >= params.maxRunMs) return false;
  return true;
}

/**
 * Archive (flag-flip) eligible activity_logs rows in batches.
 *
 * Each batch selects up to `batchSize` not-yet-archived rows older than the
 * cutoff (oldest first by chainSeq) and sets `isArchived = true` on exactly
 * those ids. Because the next select re-filters on `isArchived = false`, the
 * window self-advances without an offset and cannot loop forever.
 */
export async function archiveActivityLogs(
  database: DB,
  opts: ArchiveActivityLogsOptions,
): Promise<ArchiveActivityLogsResult> {
  const now = opts.now ?? new Date();
  const clock = opts.clock ?? (() => Date.now());
  const cutoff = new Date(now.getTime() - opts.archiveDays * 24 * 60 * 60 * 1000);
  const start = clock();

  let archived = 0;
  let batches = 0;

  for (;;) {
    const rows = await database
      .select({ id: activityLogs.id })
      .from(activityLogs)
      .where(and(lt(activityLogs.timestamp, cutoff), eq(activityLogs.isArchived, false)))
      .orderBy(asc(activityLogs.chainSeq))
      .limit(opts.batchSize);

    if (rows.length === 0) break;

    const ids = rows.map((r) => r.id);
    // Flag flip ONLY — never any hash-chain or rollback-provenance field.
    await database.update(activityLogs).set({ isArchived: true }).where(inArray(activityLogs.id, ids));

    archived += ids.length;
    batches += 1;

    if (
      !shouldContinueArchiving({
        lastBatchSize: ids.length,
        batchSize: opts.batchSize,
        elapsedMs: clock() - start,
        maxRunMs: opts.maxRunMs,
      })
    ) {
      break;
    }
  }

  return { table: 'activity_logs', archived, batches };
}
