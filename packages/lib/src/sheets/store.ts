/**
 * @module @pagespace/lib/sheets/store
 * @description Row-backed persistence for sheets.
 *
 * Replaces the model where a sheet was a `#%PAGESPACE_SHEETDOC v1` string in
 * `pages.content` that every cell edit parsed, mutated and re-serialised in
 * full. That made a write O(document) — measured at ~17s of CPU for one cell on
 * a 100k-row sheet, before I/O, and persisted the whole document roughly four
 * times over per edit.
 *
 * Here a cell write touches the rows it names plus the dependency closure that
 * actually changed. Reads never evaluate: `sheet_rows.cells` carries the
 * materialised value beside the authored text.
 *
 * Server-only — this module talks to the database. Pure conversion between rows
 * and `SheetData` lives in `./projection`, which is what the exporters, the
 * publisher and the editor use.
 */

import { db } from '@pagespace/db/db';
import { and, eq, gte, inArray, sql, asc } from '@pagespace/db/operators';
import {
  sheetTabs,
  sheetRows,
  sheetCellDeps,
  sheetRangeDeps,
  sheetChanges,
  type StoredCell,
} from '@pagespace/db/schema';
import type { SheetData, SheetCellUpdate } from './types';
import {
  decodeCellAddress,
  encodeColumnLabel,
  decodeColumnLabel,
} from './address';
import { extractFormulaDependencies } from './deps';
import { evaluateAddresses } from './evaluation';
import {
  sheetDataFromRows,
  rowsFromSheetData,
  type StoredRow,
  type StoredTab,
} from './projection';

type Executor = typeof db;

/** Recompute closures are bounded so one pathological sheet cannot hang a request. */
export const MAX_RECOMPUTE_CLOSURE = 250_000;

/**
 * Above this many cells in one call, the change log records a single summary
 * entry instead of one row per cell.
 *
 * A bulk import is one logical act, and per-cell attribution for it is both
 * useless and ruinous: a 100k-row load would otherwise write 800k log rows —
 * reintroducing, in the audit trail, exactly the write amplification the row
 * store removed from the data.
 */
export const CHANGE_LOG_SUMMARY_THRESHOLD = 500;

/**
 * Postgres refuses a statement with more than 65535 bind parameters (it fails
 * as protocol error 08P01, not a friendly message). Every multi-row insert here
 * batches well under that.
 */
const INSERT_CHUNK_ROWS = 500;

/** Rows a single `query-rows`/read call will return without explicit paging. */
export const DEFAULT_ROW_PAGE_SIZE = 200;
export const MAX_ROW_PAGE_SIZE = 5_000;

export interface SheetActor {
  userId?: string | null;
  actorEmail?: string | null;
  changeGroupId?: string | null;
  /**
   * Set by a caller that logs the operation itself at a coarser grain — an
   * append logs one `insert_rows` entry, not one entry per cell it wrote.
   */
  suppressCellLog?: boolean;
}

export interface TabRef {
  pageId: string;
  tabIndex?: number;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getTab(
  ref: TabRef,
  exec: Executor = db
): Promise<(StoredTab & { id: string }) | null> {
  const [row] = await exec
    .select()
    .from(sheetTabs)
    .where(and(eq(sheetTabs.pageId, ref.pageId), eq(sheetTabs.tabIndex, ref.tabIndex ?? 0)))
    .limit(1);

  return row ? toStoredTab(row) : null;
}

export async function listTabs(pageId: string, exec: Executor = db) {
  return exec
    .select()
    .from(sheetTabs)
    .where(eq(sheetTabs.pageId, pageId))
    .orderBy(asc(sheetTabs.tabIndex))
    .limit(MAX_ROW_PAGE_SIZE);
}

export interface ReadRowsOptions {
  /** 0-based, inclusive. */
  fromRow?: number;
  /** Number of rows, capped at `MAX_ROW_PAGE_SIZE`. */
  limit?: number;
}

/**
 * A window of rows.
 *
 * Windowed by default because the editor's viewport and an agent's query both
 * want a slice; fetching the sheet is the exception, not the rule.
 */
export async function readRows(
  tabId: string,
  options: ReadRowsOptions = {},
  exec: Executor = db
): Promise<StoredRow[]> {
  const from = Math.max(0, options.fromRow ?? 0);
  const limit = clampPageSize(options.limit);

  const rows = await exec
    .select({ rowIndex: sheetRows.rowIndex, cells: sheetRows.cells })
    .from(sheetRows)
    .where(and(eq(sheetRows.tabId, tabId), gte(sheetRows.rowIndex, from)))
    .orderBy(asc(sheetRows.rowIndex))
    .limit(limit);

  return rows.map((row) => ({ rowIndex: row.rowIndex, cells: row.cells ?? {} }));
}

/**
 * Every row of a tab, streamed in pages.
 *
 * For the paths that genuinely need the whole sheet — export, publish, snapshot
 * — and deliberately not for anything on a request path that could just take a
 * window.
 */
export async function* streamRows(
  tabId: string,
  exec: Executor = db,
  pageSize = MAX_ROW_PAGE_SIZE
): AsyncGenerator<StoredRow> {
  let cursor = 0;
  for (;;) {
    const page = await readRows(tabId, { fromRow: cursor, limit: pageSize }, exec);
    if (page.length === 0) return;
    for (const row of page) yield row;
    cursor = page[page.length - 1].rowIndex + 1;
  }
}

/**
 * A whole tab as `SheetData`.
 *
 * The compatibility bridge: exporters, the publisher and the validators keep
 * speaking `SheetData` and do not know rows exist. O(sheet) by nature, so it
 * belongs only on paths that are about the whole sheet.
 */
export async function readSheetData(ref: TabRef, exec: Executor = db): Promise<SheetData | null> {
  const tab = await getTab(ref, exec);
  if (!tab) return null;

  const rows: StoredRow[] = [];
  for await (const row of streamRows(tab.id, exec)) rows.push(row);

  return sheetDataFromRows(tab, rows);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface SetCellsResult {
  /** Cells whose stored value changed, including recomputed dependents. */
  changed: string[];
  /** Formula cells recomputed because something they read moved. */
  recomputed: string[];
  rowCount: number;
  columnCount: number;
}

/**
 * Write cells and repair everything that depended on them.
 *
 * The shape of the work: apply the authored text, re-derive the dependency
 * edges for the cells that changed, walk those edges to the closure of formulas
 * whose inputs moved, evaluate exactly that closure, and persist. Nothing reads
 * or rewrites the rest of the sheet.
 */
export async function setCells(
  ref: TabRef,
  updates: readonly SheetCellUpdate[],
  actor: SheetActor = {},
  exec?: Executor
): Promise<SetCellsResult> {
  const run = async (tx: Executor): Promise<SetCellsResult> => {
    const tab = await getTab(ref, tx);
    if (!tab) throw new Error(`Sheet tab not found for page ${ref.pageId}`);

    const normalized = normalizeUpdates(updates);
    if (normalized.length === 0) {
      return { changed: [], recomputed: [], rowCount: tab.rowCount, columnCount: tab.columnCount };
    }

    // 1. Apply authored text to the rows the updates name.
    const touchedRowIndexes = unique(normalized.map((u) => u.position.row));
    const existing = await loadRowsByIndex(tab.id, touchedRowIndexes, tx);

    const before: Record<string, StoredCell | undefined> = {};
    for (const update of normalized) {
      const row = existing.get(update.position.row) ?? { rowIndex: update.position.row, cells: {} };
      const label = encodeColumnLabel(update.position.column);
      before[update.address] = row.cells[label];
      const previousFormat = row.cells[label]?.format;

      // Clearing contents keeps formatting, as in Excel and Google Sheets, and
      // as `updateSheetCells` already does for the document path.
      row.cells[label] = previousFormat
        ? { raw: update.value, format: previousFormat }
        : { raw: update.value };

      existing.set(update.position.row, row);
    }

    // 2. Re-derive dependency edges for the cells that changed.
    await rewriteDependencyEdges(tab.id, normalized, tx);

    // 3. Walk to the closure of formulas whose inputs moved.
    const dirty = normalized.map((u) => u.address);
    const closure = await resolveDependentClosure(tab.id, dirty, tx);

    // 4. Evaluate the dirty cells and that closure, and nothing else.
    const toEvaluate = unique([...dirty, ...closure]);
    const evaluated = await evaluateClosure(tab, toEvaluate, existing, tx);

    // 5. Persist.
    applyEvaluation(existing, evaluated);
    const grown = growExtent(tab, normalized);
    await persistRows(tab.id, ref.pageId, existing, tx);
    if (grown) await updateExtent(tab.id, grown, tx);

    if (!actor.suppressCellLog) {
      const entries =
        normalized.length > CHANGE_LOG_SUMMARY_THRESHOLD
          ? [{
              op: 'set_cells' as const,
              address: null,
              rowIndex: normalized[0].position.row,
              before: null,
              after: {
                cells: normalized.length,
                firstAddress: normalized[0].address,
                lastAddress: normalized[normalized.length - 1].address,
              },
            }]
          : normalized.map((update) => ({
              op: 'set_cells' as const,
              address: update.address,
              rowIndex: update.position.row,
              before: before[update.address] ?? null,
              after:
                existing.get(update.position.row)?.cells[encodeColumnLabel(update.position.column)] ??
                null,
            }));

      await appendChanges(ref.pageId, tab.id, actor, entries, tx);
    }

    return {
      changed: unique([...dirty, ...closure]),
      recomputed: closure,
      rowCount: grown?.rowCount ?? tab.rowCount,
      columnCount: grown?.columnCount ?? tab.columnCount,
    };
  };

  return exec ? run(exec) : db.transaction(run);
}

export interface AppendRowsResult {
  firstRowIndex: number;
  appended: number;
  rowCount: number;
}

/**
 * Append rows at the end of the tab.
 *
 * The operation the document model could not express: a form submission or an
 * agent import previously had to rewrite the entire sheet to add one row. Here
 * it is an INSERT, and the recompute touches only formulas whose ranges cover
 * the new rows.
 */
export async function appendRows(
  ref: TabRef,
  rows: readonly Record<string, string>[],
  actor: SheetActor = {},
  exec?: Executor
): Promise<AppendRowsResult> {
  const run = async (tx: Executor): Promise<AppendRowsResult> => {
    const tab = await getTab(ref, tx);
    if (!tab) throw new Error(`Sheet tab not found for page ${ref.pageId}`);
    if (rows.length === 0) {
      return { firstRowIndex: tab.rowCount, appended: 0, rowCount: tab.rowCount };
    }

    const [{ maxIndex } = { maxIndex: null }] = await tx
      .select({ maxIndex: sql<number | null>`max(${sheetRows.rowIndex})` })
      .from(sheetRows)
      .where(eq(sheetRows.tabId, tab.id));

    // Append past whichever is further along: the declared extent, or the last
    // row that actually exists. Trusting only one of them would either overwrite
    // real data or leave a gap.
    const firstRowIndex = Math.max(tab.rowCount, (maxIndex ?? -1) + 1);

    const updates: NormalizedUpdate[] = [];
    rows.forEach((cells, offset) => {
      for (const [label, value] of Object.entries(cells)) {
        const column = decodeColumnLabel(label);
        const row = firstRowIndex + offset;
        updates.push({
          address: `${label.toUpperCase()}${row + 1}`,
          value,
          position: { row, column },
        });
      }
    });

    // The append logs itself, below, as one entry: the inner per-cell log would
    // be both redundant and unbounded for a bulk load.
    await setCells(
      ref,
      updates.map(({ address, value }) => ({ address, value })),
      { ...actor, suppressCellLog: true },
      tx
    );

    const rowCount = Math.max(tab.rowCount, firstRowIndex + rows.length);
    await updateExtent(tab.id, { rowCount, columnCount: tab.columnCount }, tx);

    await appendChanges(
      ref.pageId,
      tab.id,
      actor,
      [{ op: 'insert_rows', address: null, rowIndex: firstRowIndex, before: null, after: { appended: rows.length } }],
      tx
    );

    return { firstRowIndex, appended: rows.length, rowCount };
  };

  return exec ? run(exec) : db.transaction(run);
}

/**
 * Delete rows and close the gap.
 *
 * Row indexes above the deleted span shift down, which moves cells without
 * changing their text — so every formula that referenced them is stale. The
 * honest thing at this layer is to say so: the caller must rebuild dependents,
 * and `rebuildTab` is the supported way.
 */
export async function deleteRows(
  ref: TabRef,
  fromRow: number,
  count: number,
  actor: SheetActor = {},
  exec?: Executor
): Promise<{ deleted: number; rowCount: number }> {
  const run = async (tx: Executor) => {
    const tab = await getTab(ref, tx);
    if (!tab) throw new Error(`Sheet tab not found for page ${ref.pageId}`);
    if (count <= 0) return { deleted: 0, rowCount: tab.rowCount };

    const end = fromRow + count - 1;
    await tx
      .delete(sheetRows)
      .where(
        and(
          eq(sheetRows.tabId, tab.id),
          gte(sheetRows.rowIndex, fromRow),
          sql`${sheetRows.rowIndex} <= ${end}`
        )
      );

    await tx
      .update(sheetRows)
      .set({ rowIndex: sql`${sheetRows.rowIndex} - ${count}` })
      .where(and(eq(sheetRows.tabId, tab.id), sql`${sheetRows.rowIndex} > ${end}`));

    const rowCount = Math.max(0, tab.rowCount - count);
    await updateExtent(tab.id, { rowCount, columnCount: tab.columnCount }, tx);

    await appendChanges(
      ref.pageId,
      tab.id,
      actor,
      [{ op: 'delete_rows', address: null, rowIndex: fromRow, before: { count }, after: null }],
      tx
    );

    return { deleted: count, rowCount };
  };

  return exec ? run(exec) : db.transaction(run);
}

/**
 * Rebuild a tab's materialised values and dependency edges from scratch.
 *
 * The repair path, and the one operation that is deliberately O(sheet): after a
 * structural change (a row delete shifting indexes), incremental recompute
 * cannot be trusted because the addresses themselves moved.
 */
export async function rebuildTab(ref: TabRef, exec?: Executor): Promise<{ rows: number }> {
  const run = async (tx: Executor) => {
    const tab = await getTab(ref, tx);
    if (!tab) throw new Error(`Sheet tab not found for page ${ref.pageId}`);

    const rows: StoredRow[] = [];
    for await (const row of streamRows(tab.id, tx)) rows.push(row);

    const materialized = rowsFromSheetData(sheetDataFromRows(tab, rows), tab.tabIndex);

    const byIndex = new Map(materialized.rows.map((row) => [row.rowIndex, row]));
    await persistRows(tab.id, ref.pageId, byIndex, tx);

    await tx.delete(sheetCellDeps).where(eq(sheetCellDeps.tabId, tab.id));
    await tx.delete(sheetRangeDeps).where(eq(sheetRangeDeps.tabId, tab.id));
    await insertDependencyRows(tab.id, materialized.cellDeps, materialized.rangeDeps, tx);

    return { rows: materialized.rows.length };
  };

  return exec ? run(exec) : db.transaction(run);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface NormalizedUpdate {
  address: string;
  value: string;
  position: { row: number; column: number };
}

function normalizeUpdates(updates: readonly SheetCellUpdate[]): NormalizedUpdate[] {
  const byAddress = new Map<string, NormalizedUpdate>();

  for (const update of updates) {
    const address = update.address.trim().toUpperCase();
    let position: { row: number; column: number };
    try {
      position = decodeCellAddress(address);
    } catch {
      throw new Error(`Invalid cell address: ${update.address}`);
    }
    // Last write wins within one batch, matching the document path.
    byAddress.set(address, { address, value: update.value, position });
  }

  return Array.from(byAddress.values());
}

async function loadRowsByIndex(
  tabId: string,
  indexes: number[],
  exec: Executor
): Promise<Map<number, StoredRow>> {
  const map = new Map<number, StoredRow>();
  if (indexes.length === 0) return map;

  const rows = await exec
    .select({ rowIndex: sheetRows.rowIndex, cells: sheetRows.cells })
    .from(sheetRows)
    .where(and(eq(sheetRows.tabId, tabId), inArray(sheetRows.rowIndex, indexes)))
    .limit(Math.max(indexes.length, 1));

  for (const row of rows) {
    map.set(row.rowIndex, { rowIndex: row.rowIndex, cells: { ...(row.cells ?? {}) } });
  }
  return map;
}

/**
 * Replace the dependency edges of the cells that just changed.
 *
 * Only theirs: a cell whose text did not change still reads the same inputs,
 * and rewriting every edge would be the O(sheet) work this design removes.
 */
async function rewriteDependencyEdges(
  tabId: string,
  updates: NormalizedUpdate[],
  exec: Executor
): Promise<void> {
  const addresses = updates.map((u) => u.address);

  await exec
    .delete(sheetCellDeps)
    .where(and(eq(sheetCellDeps.tabId, tabId), inArray(sheetCellDeps.address, addresses)));
  await exec
    .delete(sheetRangeDeps)
    .where(and(eq(sheetRangeDeps.tabId, tabId), inArray(sheetRangeDeps.formulaAddress, addresses)));

  const cellRows: { address: string; dependsOn: string[]; dependents: string[] }[] = [];
  const rangeRows: {
    formulaAddress: string;
    rowStart: number;
    rowEnd: number | null;
    colStart: number;
    colEnd: number | null;
  }[] = [];

  for (const update of updates) {
    if (!update.value.trim().startsWith('=')) continue;
    const deps = extractFormulaDependencies(update.value);
    cellRows.push({ address: update.address, dependsOn: deps.cells, dependents: [] });
    for (const rect of deps.ranges) {
      rangeRows.push({ formulaAddress: update.address, ...rect });
    }
  }

  await insertDependencyRows(tabId, cellRows, rangeRows, exec);
}

async function insertDependencyRows(
  tabId: string,
  cellRows: { address: string; dependsOn: string[]; dependents: string[] }[],
  rangeRows: {
    formulaAddress: string;
    rowStart: number;
    rowEnd: number | null;
    colStart: number;
    colEnd: number | null;
  }[],
  exec: Executor
): Promise<void> {
  for (let index = 0; index < cellRows.length; index += INSERT_CHUNK_ROWS) {
    await exec
      .insert(sheetCellDeps)
      .values(cellRows.slice(index, index + INSERT_CHUNK_ROWS).map((row) => ({ tabId, ...row })));
  }
  for (let index = 0; index < rangeRows.length; index += INSERT_CHUNK_ROWS) {
    await exec
      .insert(sheetRangeDeps)
      .values(rangeRows.slice(index, index + INSERT_CHUNK_ROWS).map((row) => ({ tabId, ...row })));
  }
}

/**
 * Every formula transitively affected by a change to `dirty`.
 *
 * Two edge kinds, because one cannot express the other: `sheet_cell_deps` holds
 * named references, and `sheet_range_deps` holds rectangles, so that
 * `=SUM(D1:D100000)` is one row rather than 100,000.
 */
async function resolveDependentClosure(
  tabId: string,
  dirty: string[],
  exec: Executor
): Promise<string[]> {
  const seen = new Set(dirty.map((address) => address.toUpperCase()));
  const closure = new Set<string>();
  let frontier = dirty.map((address) => address.toUpperCase());

  while (frontier.length > 0) {
    const direct = await exec
      .select({ address: sheetCellDeps.address })
      .from(sheetCellDeps)
      .where(
        and(
          eq(sheetCellDeps.tabId, tabId),
          sql`${sheetCellDeps.dependsOn} && ${toTextArray(frontier)}`
        )
      )
      .limit(MAX_RECOMPUTE_CLOSURE);

    const positions = frontier.map((address) => decodeCellAddress(address));
    const viaRange = positions.length
      ? await exec
          .select({ address: sheetRangeDeps.formulaAddress })
          .from(sheetRangeDeps)
          .where(and(eq(sheetRangeDeps.tabId, tabId), rangeCovers(positions)))
          .limit(MAX_RECOMPUTE_CLOSURE)
      : [];

    const next: string[] = [];
    for (const { address } of [...direct, ...viaRange]) {
      const normalized = address.toUpperCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      closure.add(normalized);
      next.push(normalized);
    }

    if (closure.size > MAX_RECOMPUTE_CLOSURE) {
      throw new Error(
        `Recompute closure exceeded ${MAX_RECOMPUTE_CLOSURE} cells; rebuild the sheet instead`
      );
    }

    frontier = next;
  }

  return Array.from(closure);
}

/** `WHERE` matching any range that covers at least one of `positions`. */
function rangeCovers(positions: { row: number; column: number }[]) {
  const clauses = positions.map(
    (position) => sql`(
      ${sheetRangeDeps.rowStart} <= ${position.row}
      AND (${sheetRangeDeps.rowEnd} IS NULL OR ${sheetRangeDeps.rowEnd} >= ${position.row})
      AND ${sheetRangeDeps.colStart} <= ${position.column}
      AND (${sheetRangeDeps.colEnd} IS NULL OR ${sheetRangeDeps.colEnd} >= ${position.column})
    )`
  );

  return sql.join(clauses, sql` OR `);
}

function toTextArray(values: string[]) {
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

/**
 * Evaluate `addresses` against a sheet assembled from just their inputs.
 *
 * Cells outside the recompute set are injected as their stored value rather
 * than their formula: they did not change, so their result stands, and pulling
 * them in as literals is what stops the evaluation from fanning out across the
 * whole sheet.
 */
async function evaluateClosure(
  tab: StoredTab & { id: string },
  addresses: string[],
  pending: Map<number, StoredRow>,
  exec: Executor
): Promise<Record<string, { value: StoredCell['value']; type: StoredCell['type']; error?: string }>> {
  if (addresses.length === 0) return {};

  const inputRowIndexes = new Set<number>();
  for (const address of addresses) {
    inputRowIndexes.add(decodeCellAddress(address).row);
  }

  // The rows every recomputed formula reads.
  const targets = new Set(addresses.map((a) => a.toUpperCase()));
  const formulaTexts = collectRawText(pending, targets);
  for (const raw of Object.values(formulaTexts)) {
    const deps = extractFormulaDependencies(raw);
    for (const cell of deps.cells) inputRowIndexes.add(decodeCellAddress(cell).row);
    for (const rect of deps.ranges) {
      const end = rect.rowEnd ?? tab.rowCount - 1;
      for (let row = rect.rowStart; row <= end; row++) inputRowIndexes.add(row);
    }
  }

  const stored = await loadRowsByIndex(
    tab.id,
    Array.from(inputRowIndexes).filter((index) => !pending.has(index)),
    exec
  );
  for (const [index, row] of pending) stored.set(index, row);

  const cells: Record<string, string> = {};
  for (const row of stored.values()) {
    for (const [label, cell] of Object.entries(row.cells ?? {})) {
      const address = `${label}${row.rowIndex + 1}`;
      cells[address] = targets.has(address) ? cell.raw : frozenLiteral(cell);
    }
  }

  const evaluation = evaluateAddresses(
    { version: 1, rowCount: tab.rowCount, columnCount: tab.columnCount, cells },
    addresses
  );

  const result: Record<string, { value: StoredCell['value']; type: StoredCell['type']; error?: string }> = {};
  for (const [address, cell] of Object.entries(evaluation)) {
    result[address] = { value: cell.value, type: cell.type, error: cell.error };
  }
  return result;
}

/**
 * A cell frozen to its computed result.
 *
 * A formula outside the recompute set must not be re-evaluated — that is the
 * whole point — so it enters the partial sheet as its materialised value. The
 * format has no way to express "a literal that looks like a formula", so a
 * computed string beginning `=` would be re-read as one; that ambiguity is
 * inherent to `SheetData.cells` being a plain string map and predates this.
 */
function frozenLiteral(cell: StoredCell): string {
  if (cell.value === undefined || cell.value === '') {
    return cell.raw?.trim().startsWith('=') ? '' : cell.raw ?? '';
  }
  return String(cell.value);
}

function collectRawText(rows: Map<number, StoredRow>, addresses: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows.values()) {
    for (const [label, cell] of Object.entries(row.cells ?? {})) {
      const address = `${label}${row.rowIndex + 1}`;
      if (addresses.has(address)) out[address] = cell.raw ?? '';
    }
  }
  return out;
}

function applyEvaluation(
  rows: Map<number, StoredRow>,
  evaluated: Record<string, { value: StoredCell['value']; type: StoredCell['type']; error?: string }>
): void {
  for (const [address, result] of Object.entries(evaluated)) {
    const { row: rowIndex, column } = decodeCellAddress(address);
    const row = rows.get(rowIndex) ?? { rowIndex, cells: {} };
    const label = encodeColumnLabel(column);
    const existing = row.cells[label] ?? { raw: '' };

    row.cells[label] = {
      ...existing,
      value: result.value,
      type: result.type,
      ...(result.error ? { error: { type: result.error } } : {}),
    };
    if (!result.error) delete row.cells[label].error;

    rows.set(rowIndex, row);
  }
}

async function persistRows(
  tabId: string,
  pageId: string,
  rows: Map<number, StoredRow>,
  exec: Executor
): Promise<void> {
  const values = Array.from(rows.values()).map((row) => ({
    tabId,
    pageId,
    rowIndex: row.rowIndex,
    cells: row.cells,
  }));
  if (values.length === 0) return;

  // One statement per batch, upserting on the tab/row identity so an append and
  // an overwrite are the same code path.
  for (let index = 0; index < values.length; index += INSERT_CHUNK_ROWS) {
    await exec
      .insert(sheetRows)
      .values(values.slice(index, index + INSERT_CHUNK_ROWS))
      .onConflictDoUpdate({
        target: [sheetRows.tabId, sheetRows.rowIndex],
        set: { cells: sql`excluded."cells"`, updatedAt: new Date() },
      });
  }
}

function growExtent(
  tab: StoredTab,
  updates: NormalizedUpdate[]
): { rowCount: number; columnCount: number } | null {
  let rowCount = tab.rowCount;
  let columnCount = tab.columnCount;

  for (const update of updates) {
    rowCount = Math.max(rowCount, update.position.row + 1);
    columnCount = Math.max(columnCount, update.position.column + 1);
  }

  return rowCount === tab.rowCount && columnCount === tab.columnCount
    ? null
    : { rowCount, columnCount };
}

async function updateExtent(
  tabId: string,
  extent: { rowCount: number; columnCount: number },
  exec: Executor
): Promise<void> {
  await exec
    .update(sheetTabs)
    .set({ rowCount: extent.rowCount, columnCount: extent.columnCount, updatedAt: new Date() })
    .where(eq(sheetTabs.id, tabId));
}

async function appendChanges(
  pageId: string,
  tabId: string,
  actor: SheetActor,
  entries: {
    op: 'set_cells' | 'insert_rows' | 'delete_rows' | 'update_rows' | 'format' | 'resize' | 'tab';
    address: string | null;
    rowIndex: number | null;
    before: unknown;
    after: unknown;
  }[],
  exec: Executor
): Promise<void> {
  if (entries.length === 0) return;

  const values = entries.map((entry) => ({
    pageId,
    tabId,
    actorUserId: actor.userId ?? null,
    actorEmail: actor.actorEmail ?? null,
    changeGroupId: actor.changeGroupId ?? null,
    op: entry.op,
    address: entry.address,
    rowIndex: entry.rowIndex,
    before: entry.before ?? null,
    after: entry.after ?? null,
  }));

  for (let index = 0; index < values.length; index += INSERT_CHUNK_ROWS) {
    await exec.insert(sheetChanges).values(values.slice(index, index + INSERT_CHUNK_ROWS));
  }
}

function toStoredTab(row: typeof sheetTabs.$inferSelect): StoredTab & { id: string } {
  return {
    id: row.id,
    tabIndex: row.tabIndex,
    name: row.name,
    rowCount: row.rowCount,
    columnCount: row.columnCount,
    frozenRows: row.frozenRows,
    frozenColumns: row.frozenColumns,
    columnFormats: row.columnFormats,
    columnWidths: row.columnWidths,
    rowHeights: row.rowHeights,
    ranges: row.ranges,
  };
}

function clampPageSize(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_ROW_PAGE_SIZE;
  return Math.min(limit, MAX_ROW_PAGE_SIZE);
}

function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}
