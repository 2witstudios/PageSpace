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
import { pages } from '@pagespace/db/schema/core';
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
import {
  parseSheetContentSafe,
  serializeSheetContent,
  parseSheetDocString,
  isSheetDocString,
  sheetDataFromSheetDoc,
} from './io';
import { SHEET_DEFAULT_ROWS, SHEET_DEFAULT_COLUMNS } from './constants';
import { evaluateAddresses } from './evaluation';
import {
  sheetDataFromRows,
  rowsFromSheetData,
  type StoredRow,
  type StoredTab,
} from './projection';
import {
  compileWhere,
  compileOrderBy,
  assertColumn,
  type SheetWhere,
  type SheetOrderBy,
} from './query';

type Executor = typeof db;

/** Recompute closures are bounded so one pathological sheet cannot hang a request. */
export const MAX_RECOMPUTE_CLOSURE = 250_000;

/**
 * Ceiling on rows pulled in as formula inputs for a single recompute. A range
 * formula legitimately reads a lot; this stops one from reading the universe.
 */
export const MAX_INPUT_ROWS = 250_000;

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

export interface QueryRowsOptions {
  where?: SheetWhere;
  orderBy?: SheetOrderBy[];
  /** Column letters to return. Omitted means every column the row has. */
  select?: string[];
  limit?: number;
  offset?: number;
}

export interface QueryRowsResult {
  rows: { rowIndex: number; cells: Record<string, StoredCell> }[];
  /** Rows matching the filter, ignoring limit/offset. */
  total: number;
  hasMore: boolean;
}

/**
 * Filtered, sorted, paginated rows.
 *
 * The read that makes a sheet usable as a database: an agent asks for the rows
 * it wants rather than reading the document and filtering in the model. The
 * filter runs against the materialised `value`, so `=B2*C2` compares as its
 * result — possible only because writes materialise.
 *
 * `select` is applied after the row is fetched rather than pushed into SQL: the
 * saving that matters is the rows not returned, and projecting in jsonb would
 * cost more in query complexity than it saves in bytes.
 */
export async function queryRows(
  ref: TabRef,
  options: QueryRowsOptions = {},
  exec: Executor = db
): Promise<QueryRowsResult> {
  const tab = await getTab(ref, exec);
  if (!tab) throw new Error(`Sheet tab not found for page ${ref.pageId}`);

  const predicate = compileWhere(options.where);
  const ordering = compileOrderBy(options.orderBy);
  const limit = clampPageSize(options.limit);
  const offset = Math.max(0, options.offset ?? 0);
  const projection = options.select?.map(assertColumn);

  const scope = predicate
    ? and(eq(sheetRows.tabId, tab.id), predicate)
    : eq(sheetRows.tabId, tab.id);

  const [{ total }] = await exec
    .select({ total: sql<number>`count(*)::int` })
    .from(sheetRows)
    .where(scope);

  const found = await exec
    .select({ rowIndex: sheetRows.rowIndex, cells: sheetRows.cells })
    .from(sheetRows)
    .where(scope)
    // `rowIndex` always tie-breaks. Postgres gives no stable order among equal
    // sort keys ACROSS statements, so without it a filter with ties (a status
    // column, say) can return a row twice and skip another as an agent pages
    // through with limit/offset — silently corrupting a "read all matching
    // rows" loop rather than failing it.
    .orderBy(ordering ? sql`${ordering}, ${sheetRows.rowIndex} ASC` : sql`${sheetRows.rowIndex} ASC`)
    .limit(limit)
    .offset(offset);

  return {
    rows: found.map((row) => ({
      rowIndex: row.rowIndex,
      cells: projection ? pick(row.cells ?? {}, projection) : (row.cells ?? {}),
    })),
    total,
    hasMore: offset + found.length < total,
  };
}

function pick(
  cells: Record<string, StoredCell>,
  columns: string[]
): Record<string, StoredCell> {
  const out: Record<string, StoredCell> = {};
  for (const column of columns) {
    if (cells[column]) out[column] = cells[column];
  }
  return out;
}

/**
 * The tab for `ref`, creating it from the page's document if it does not exist.
 *
 * Sheets predate this store, and their content lives in `pages.content` until
 * something moves it. Nothing in the product creates a `sheet_tabs` row — only
 * the backfill script does — so every write path would otherwise throw for a
 * newly created sheet, and for any sheet an operator had not backfilled yet. A
 * public form submission would 500 and the submitted data would be discarded.
 *
 * So migration is lazy: the first row-store access to a sheet materialises its
 * document into rows. The backfill script becomes an optional bulk pre-warm
 * rather than a prerequisite.
 *
 * The important half is that a sheet WITH content never gets an empty tab.
 * Creating one would make the store believe the sheet was blank and the next
 * write would present that as the truth — losing the whole spreadsheet. A
 * document that cannot be parsed therefore fails loudly rather than
 * materialising as empty.
 */
export async function ensureTab(
  ref: TabRef,
  exec: Executor = db
): Promise<StoredTab & { id: string }> {
  const existing = await getTab(ref, exec);
  if (existing) return existing;

  const tabIndex = ref.tabIndex ?? 0;
  const [page] = await exec
    .select({ content: pages.content })
    .from(pages)
    .where(eq(pages.id, ref.pageId))
    .limit(1);

  if (!page) throw new Error(`Page ${ref.pageId} not found`);

  await materializeFromDocument(ref.pageId, page.content ?? '', exec);

  const created = await getTab({ pageId: ref.pageId, tabIndex }, exec);
  if (created) return created;

  // The document had fewer tabs than the caller asked for.
  throw new Error(`Sheet tab ${tabIndex} not found for page ${ref.pageId}`);
}

/**
 * Clone every tab and row of one sheet page onto another.
 *
 * Copying a page copies `pages.content`, which is empty for a materialised
 * sheet — so a duplicated spreadsheet came out blank. The rows have to travel
 * with it.
 */
export async function copySheetRows(
  fromPageId: string,
  toPageId: string,
  exec: Executor = db
): Promise<{ tabs: number; rows: number }> {
  const tabs = await listTabs(fromPageId, exec);
  if (tabs.length === 0) return { tabs: 0, rows: 0 };

  let rowTotal = 0;
  for (const tab of tabs) {
    const [created] = await exec
      .insert(sheetTabs)
      .values({
        pageId: toPageId,
        tabIndex: tab.tabIndex,
        name: tab.name,
        rowCount: tab.rowCount,
        columnCount: tab.columnCount,
        frozenRows: tab.frozenRows,
        frozenColumns: tab.frozenColumns,
        columnFormats: tab.columnFormats,
        columnWidths: tab.columnWidths,
        rowHeights: tab.rowHeights,
        ranges: tab.ranges,
      })
      .returning({ id: sheetTabs.id });

    const byIndex = new Map<number, StoredRow>();
    for await (const row of streamRows(tab.id, exec)) {
      byIndex.set(row.rowIndex, row);
      // Flush in batches so a very large sheet does not build the whole copy
      // in memory before writing any of it.
      if (byIndex.size >= 2_000) {
        await persistRows(created.id, toPageId, byIndex, exec, 'replace');
        rowTotal += byIndex.size;
        byIndex.clear();
      }
    }
    if (byIndex.size > 0) {
      await persistRows(created.id, toPageId, byIndex, exec, 'replace');
      rowTotal += byIndex.size;
    }

    // Dependency edges are addresses, not ids, so they copy verbatim.
    const cellDeps = await exec
      .select()
      .from(sheetCellDeps)
      .where(eq(sheetCellDeps.tabId, tab.id));
    const rangeDeps = await exec
      .select()
      .from(sheetRangeDeps)
      .where(eq(sheetRangeDeps.tabId, tab.id));

    await insertDependencyRows(
      created.id,
      cellDeps.map((dep) => ({ address: dep.address, dependsOn: dep.dependsOn, dependents: dep.dependents })),
      rangeDeps.map((dep) => ({
        formulaAddress: dep.formulaAddress,
        rowStart: dep.rowStart,
        rowEnd: dep.rowEnd,
        colStart: dep.colStart,
        colEnd: dep.colEnd,
      })),
      exec
    );
  }

  return { tabs: tabs.length, rows: rowTotal };
}

/** The tab at `tabIndex`, created from `sheet`'s shape if it does not exist. */
async function ensureTabAt(
  pageId: string,
  tabIndex: number,
  sheet: SheetData,
  exec: Executor
): Promise<{ id: string }> {
  const [existing] = await exec
    .select({ id: sheetTabs.id })
    .from(sheetTabs)
    .where(and(eq(sheetTabs.pageId, pageId), eq(sheetTabs.tabIndex, tabIndex)))
    .limit(1);
  if (existing) return existing;

  const [created] = await exec
    .insert(sheetTabs)
    .values({
      pageId,
      tabIndex,
      name: sheet.sheetName ?? `Sheet${tabIndex + 1}`,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
    })
    .returning({ id: sheetTabs.id });
  return created;
}

/**
 * Materialise a `#%PAGESPACE_SHEETDOC` document into rows.
 *
 * Shared by lazy provisioning and by the bulk backfill script, so there is one
 * implementation of "what does this document become" rather than two that can
 * drift. Idempotent: a page that already has tabs is left alone, which is what
 * makes concurrent first-writes safe and the script re-runnable.
 */
export async function materializeFromDocument(
  pageId: string,
  content: string,
  exec?: Executor
): Promise<{ tabs: number; rows: number }> {
  const run = async (tx: Executor) => {
    // Lock the page row first, THEN re-check.
    //
    // A bare SELECT under READ COMMITTED lets two concurrent first-writes both
    // see no tabs and both insert; one then dies on
    // `sheet_tabs_page_tab_unique`. That turns corruption into a failed write,
    // which is better but still a failed write. Serialising on the page makes
    // the second caller see the first one's tabs and return.
    await tx.select({ id: pages.id }).from(pages).where(eq(pages.id, pageId)).for('update');

    const [already] = await tx
      .select({ id: sheetTabs.id })
      .from(sheetTabs)
      .where(eq(sheetTabs.pageId, pageId))
      .limit(1);
    if (already) return { tabs: 0, rows: 0 };

    const sheets = documentTabs(content);

    let rowTotal = 0;
    for (const [tabIndex, sheet] of sheets.entries()) {
      const materialized = rowsFromSheetData(sheet, tabIndex);

      const [tab] = await tx
        .insert(sheetTabs)
        .values({
          pageId,
          tabIndex,
          name: materialized.tab.name,
          rowCount: materialized.tab.rowCount,
          columnCount: materialized.tab.columnCount,
          frozenRows: materialized.tab.frozenRows,
          frozenColumns: materialized.tab.frozenColumns,
          columnFormats: materialized.tab.columnFormats,
          columnWidths: materialized.tab.columnWidths,
          rowHeights: materialized.tab.rowHeights,
          ranges: materialized.tab.ranges,
        })
        .returning({ id: sheetTabs.id });

      const byIndex = new Map(materialized.rows.map((row) => [row.rowIndex, row]));
      await persistRows(tab.id, pageId, byIndex, tx);
      await insertDependencyRows(tab.id, materialized.cellDeps, materialized.rangeDeps, tx);
      rowTotal += materialized.rows.length;
    }

    return { tabs: sheets.length, rows: rowTotal };
  };

  return exec ? run(exec) : db.transaction(run);
}

/**
 * Every tab a stored document describes.
 *
 * `parseSheetContentSafe` returns only the first sheet; a multi-tab document
 * keeps the rest in the doc's `sheets` array. Reading only the first would
 * silently delete every other tab on materialisation.
 */
function documentTabs(content: string): SheetData[] {
  if (!content.trim()) {
    return [
      {
        version: 1,
        rowCount: SHEET_DEFAULT_ROWS,
        columnCount: SHEET_DEFAULT_COLUMNS,
        cells: {},
        sheetName: 'Sheet1',
      },
    ];
  }

  const parsed = parseSheetContentSafe(content);
  if (!parsed.ok) {
    // Loudly. Materialising an unreadable document as an empty sheet would
    // present "this spreadsheet is blank" as the truth, and the next write
    // would make it so.
    throw new Error(
      `Sheet content could not be read (${parsed.reason}); refusing to materialise it as empty.`
    );
  }

  const tabs: SheetData[] = [parsed.sheet];
  if (isSheetDocString(content)) {
    const doc = parseSheetDocString(content);
    for (let index = 1; index < doc.sheets.length; index++) {
      tabs.push(sheetDataFromSheetDoc({ ...doc, sheets: [doc.sheets[index]] }));
    }
  }
  return tabs;
}

/**
 * The whole sheet as a `#%PAGESPACE_SHEETDOC` document, generated from rows.
 *
 * This is the projection that lets everything which already speaks the document
 * format — the editor, exports, the publisher, the AI read path — keep working
 * unchanged while rows are the source of truth. It is generated on demand and
 * never stored: writing it back to `pages.content` would put the O(document)
 * write this design removed straight back into every edit.
 *
 * O(sheet) by nature, so it belongs only on paths that are genuinely about the
 * whole sheet. A viewport or a filter should use `readRows`/`queryRows`.
 */
export async function readSheetDocument(pageId: string, exec: Executor = db): Promise<string | null> {
  const tabs = await listTabs(pageId, exec);
  if (tabs.length === 0) return null;

  const asSheetData = async (tab: typeof tabs[number]): Promise<SheetData> => {
    const rows: StoredRow[] = [];
    for await (const row of streamRows(tab.id, exec)) rows.push(row);
    return sheetDataFromRows(toStoredTab(tab), rows);
  };

  const base = await asSheetData(tabs[0]);

  // Tabs after the first ride in `extraSheets`, which the serialiser folds back
  // into the document's sheet list. Round-tripping each through the serialiser
  // is how a `SheetData` becomes the `SheetDocSheet` that field wants, and
  // reuses the one tested conversion rather than reimplementing it.
  if (tabs.length > 1) {
    const extras = [];
    for (const tab of tabs.slice(1)) {
      const data = await asSheetData(tab);
      const doc = parseSheetDocString(serializeSheetContent(data, { pageId }));
      if (doc.sheets[0]) extras.push({ ...doc.sheets[0], order: tab.tabIndex });
    }
    base.extraSheets = extras;
  }

  return serializeSheetContent(base, { pageId });
}

/**
 * Replace a tab's contents with a document.
 *
 * The editor still sends a whole serialised sheet on save, so this is the
 * bridge for that path: parse it, write the rows it describes, and remove the
 * ones it does not. O(document) and unavoidably so until the editor sends cell
 * deltas — but it is the interactive path, where the client has already
 * re-serialised anyway. The programmatic paths (forms, MCP, SDK) address cells
 * and stay O(1).
 */
export async function replaceFromDocument(
  ref: TabRef,
  content: string,
  actor: SheetActor = {},
  exec?: Executor
): Promise<{ rows: number }> {
  const run = async (tx: Executor) => {
    // EVERY tab the document describes, not just the first.
    //
    // The document is the complete statement of the sheet, and this is the only
    // path an editor save takes. Writing tab 0 alone silently discarded edits to
    // every other tab — and, for a sheet whose extra tabs existed only in the
    // document, deleted them outright.
    await ensureTab(ref, tx);
    const sheets = documentTabs(content);

    let rowTotal = 0;
    for (const [tabIndex, sheet] of sheets.entries()) {
      const tab = await ensureTabAt(ref.pageId, tabIndex, sheet, tx);
      const materialized = rowsFromSheetData(sheet, tabIndex);
      const byIndex = new Map(materialized.rows.map((row) => [row.rowIndex, row]));

      const existing = await tx
        .select({ rowIndex: sheetRows.rowIndex })
        .from(sheetRows)
        .where(eq(sheetRows.tabId, tab.id));

      const stale = existing.map((row) => row.rowIndex).filter((index) => !byIndex.has(index));
      const DELETE_CHUNK = 5_000;
      for (let index = 0; index < stale.length; index += DELETE_CHUNK) {
        await tx
          .delete(sheetRows)
          .where(
            and(
              eq(sheetRows.tabId, tab.id),
              inArray(sheetRows.rowIndex, stale.slice(index, index + DELETE_CHUNK))
            )
          );
      }

      // Replace, not merge: a cell absent from the document has been removed.
      await persistRows(tab.id, ref.pageId, byIndex, tx, 'replace');

      await tx.delete(sheetCellDeps).where(eq(sheetCellDeps.tabId, tab.id));
      await tx.delete(sheetRangeDeps).where(eq(sheetRangeDeps.tabId, tab.id));
      await insertDependencyRows(tab.id, materialized.cellDeps, materialized.rangeDeps, tx);

      await updateExtent(
        tab.id,
        { rowCount: materialized.tab.rowCount, columnCount: materialized.tab.columnCount },
        tx
      );

      rowTotal += materialized.rows.length;
    }

    // Tabs the document no longer has were deleted in the editor.
    const surplus = await tx
      .select({ id: sheetTabs.id, tabIndex: sheetTabs.tabIndex })
      .from(sheetTabs)
      .where(eq(sheetTabs.pageId, ref.pageId));
    for (const tab of surplus) {
      if (tab.tabIndex >= sheets.length) {
        await tx.delete(sheetTabs).where(eq(sheetTabs.id, tab.id));
      }
    }

    await appendChanges(
      ref.pageId,
      null,
      actor,
      [{ op: 'update_rows', address: null, rowIndex: null, before: null, after: { tabs: sheets.length, rows: rowTotal } }],
      tx
    );

    return { rows: rowTotal };
  };

  return exec ? run(exec) : db.transaction(run);
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
    const tab = await ensureTab(ref, tx);

    const normalized = normalizeUpdates(updates);
    if (normalized.length === 0) {
      return { changed: [], recomputed: [], rowCount: tab.rowCount, columnCount: tab.columnCount };
    }

    // 1. Apply authored text to the rows the updates name.
    //
    // `working` is the set of rows this call may WRITE, and every row in it is
    // loaded whole before being modified. That invariant matters because
    // `persistRows` upserts the entire `cells` object: writing a row that was
    // only partially loaded would silently delete every column it did not know
    // about.
    const touchedRowIndexes = unique(normalized.map((u) => u.position.row));
    const working = await loadRowsByIndex(tab.id, touchedRowIndexes, tx, true);

    const before: Record<string, StoredCell | undefined> = {};
    for (const update of normalized) {
      const row = working.get(update.position.row) ?? { rowIndex: update.position.row, cells: {} };
      const label = encodeColumnLabel(update.position.column);
      const previous = row.cells[label];
      before[update.address] = previous;

      // Spread the previous cell rather than rebuilding it, so formatting —
      // and anything else `StoredCell` grows later, such as notes — survives an
      // edit. Clearing contents keeps formatting, as in Excel and Sheets, and
      // as `updateSheetCells` already does on the document path.
      row.cells[label] = { ...(previous ?? {}), raw: update.value, value: undefined, type: undefined };
      delete row.cells[label].error;

      working.set(update.position.row, row);
    }

    // 2. Re-derive dependency edges for the cells that changed.
    await rewriteDependencyEdges(tab.id, normalized, tx);

    // 3. Walk to the closure of formulas whose inputs moved.
    const dirty = normalized.map((u) => u.address);
    const closure = await resolveDependentClosure(tab.id, dirty, tx);

    // 4. Load the rows holding those dependents, so recomputing a formula in an
    // untouched row rewrites that row with its other columns intact.
    const closureRowIndexes = unique(closure.map((address) => decodeCellAddress(address).row));
    await mergeMissingRows(working, tab.id, closureRowIndexes, tx, true);

    // 5. Evaluate the dirty cells and that closure, and nothing else.
    const toEvaluate = unique([...dirty, ...closure]);
    const evaluated = await evaluateClosure(tab, toEvaluate, working, tx);

    // 6. Persist.
    applyEvaluation(working, evaluated);
    const grown = growExtent(tab, normalized);
    await persistRows(tab.id, ref.pageId, working, tx);
    if (grown) await updateExtent(tab.id, grown, tx);
    await touchPage(ref.pageId, tx);

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
                working.get(update.position.row)?.cells[encodeColumnLabel(update.position.column)] ??
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
    const tab = await ensureTab(ref, tx);
    if (rows.length === 0) {
      return { firstRowIndex: tab.rowCount, appended: 0, rowCount: tab.rowCount };
    }

    // Serialise appends to this tab.
    //
    // `max(rowIndex)` read without a lock is a classic lost-append: two callers
    // both compute the same `firstRowIndex`, and because `persistRows` upserts,
    // the second does not conflict — it overwrites the first caller's rows and
    // reports success. Locking the tab row makes concurrent appends queue.
    await tx
      .select({ id: sheetTabs.id })
      .from(sheetTabs)
      .where(eq(sheetTabs.id, tab.id))
      .for('update');

    const [{ maxIndex } = { maxIndex: null }] = await tx
      .select({ maxIndex: sql<number | null>`max(${sheetRows.rowIndex})` })
      .from(sheetRows)
      .where(eq(sheetRows.tabId, tab.id));

    // After the last POPULATED row, not the declared extent.
    //
    // A default sheet declares 20 rows with nothing in them, and an
    // editor-grown sheet routinely declares hundreds past its last real row.
    // Appending past the extent therefore dropped an agent's rows into row 21
    // (or row 501) of a three-row table, leaving a block of blank rows above
    // them. The extent is how big the grid looks; `max(rowIndex)` is where the
    // data actually ends.
    const firstRowIndex = (maxIndex ?? -1) + 1;

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

    // Re-read: the inner `setCells` widens `columnCount` when the appended rows
    // use columns past the tab's declared width. Writing back the pre-call
    // snapshot would revert that, leaving the editor rendering a grid too
    // narrow to show the data just written.
    const current = await getTab(ref, tx);
    const rowCount = Math.max(current?.rowCount ?? tab.rowCount, firstRowIndex + rows.length);
    await updateExtent(
      tab.id,
      { rowCount, columnCount: current?.columnCount ?? tab.columnCount },
      tx
    );
    await touchPage(ref.pageId, tx);

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

    // Clamp to what exists. `count` arrives from a caller (an agent may send
    // 100,000) and the span can sit entirely past the end of the sheet, in
    // which case nothing is deleted and nothing should shift or shrink.
    const [{ maxIndex: maxBefore } = { maxIndex: null }] = await tx
      .select({ maxIndex: sql<number | null>`max(${sheetRows.rowIndex})` })
      .from(sheetRows)
      .where(eq(sheetRows.tabId, tab.id));

    // The declared extent, not the last populated row, is what a delete acts
    // on: a tab can declare 1000 rows while holding data only in the first ten,
    // and "delete rows 501-510" must still shrink the grid the user sees. Rows
    // are removed where they exist; the extent shrinks either way.
    const lastRow = Math.max(maxBefore ?? -1, tab.rowCount - 1);
    if (fromRow > lastRow) {
      return { deleted: 0, rowCount: tab.rowCount };
    }
    const effectiveCount = Math.min(count, lastRow - fromRow + 1);

    await tx
      .delete(sheetRows)
      .where(
        and(
          eq(sheetRows.tabId, tab.id),
          gte(sheetRows.rowIndex, fromRow),
          sql`${sheetRows.rowIndex} <= ${end}`
        )
      );

    // Two passes, through a scratch range above every existing index.
    //
    // `sheet_rows_tab_row_unique` is not deferrable and Postgres checks it per
    // row mid-statement, so a single `rowIndex = rowIndex - count` collides
    // with a row the statement has not moved yet whenever the heap order is not
    // ascending by rowIndex — which it generally is not after upserts. The
    // failure is non-deterministic, which is worse than consistent.
    //
    // The scratch range is ABOVE the current maximum, not below zero: negative
    // indexes would satisfy uniqueness but violate
    // `sheet_rows_row_index_non_negative`, which is checked per row just the
    // same. Offsetting by max+1 guarantees the parked rows cannot collide with
    // the rows that stayed put, since those are all <= max.
    const [{ maxIndex } = { maxIndex: null }] = await tx
      .select({ maxIndex: sql<number | null>`max(${sheetRows.rowIndex})` })
      .from(sheetRows)
      .where(eq(sheetRows.tabId, tab.id));

    const scratch = (maxIndex ?? 0) + 1;
    await tx
      .update(sheetRows)
      .set({ rowIndex: sql`${sheetRows.rowIndex} + ${scratch}` })
      .where(and(eq(sheetRows.tabId, tab.id), sql`${sheetRows.rowIndex} > ${end}`));
    await tx
      .update(sheetRows)
      .set({ rowIndex: sql`${sheetRows.rowIndex} - ${scratch + effectiveCount}` })
      .where(and(eq(sheetRows.tabId, tab.id), sql`${sheetRows.rowIndex} > ${maxIndex ?? 0}`));

    const rowCount = Math.max(0, tab.rowCount - effectiveCount);
    await updateExtent(tab.id, { rowCount, columnCount: tab.columnCount }, tx);
    await touchPage(ref.pageId, tx);

    // Rebuild, and do not leave it to the caller.
    //
    // Shifting indexes moves cells without changing their text, so every
    // formula that referenced them is now stale AND every dependency edge names
    // an address that has moved or ceased to exist. Leaving that to a caller
    // meant it never happened: stale materialised values, edges pointing at
    // deleted addresses, and a later recompute resolving a closure containing a
    // formula that is gone. This is O(sheet) and deliberately so — a structural
    // change is the one operation incremental recompute cannot express.
    await rebuildTab(ref, tx);

    await appendChanges(
      ref.pageId,
      tab.id,
      actor,
      [{ op: 'delete_rows', address: null, rowIndex: fromRow, before: { count: effectiveCount }, after: null }],
      tx
    );

    return { deleted: effectiveCount, rowCount };
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

    // `persistRows` only upserts. A row that has become entirely empty is
    // absent from the projection, so without this its stale materialised value
    // would survive the repair and keep being returned by reads.
    // Delete by enumerating what is actually there and subtracting what the
    // projection kept, in chunks. A `<> ALL(ARRAY[...])` over the kept set
    // would emit one bind parameter per surviving row, so the repair path would
    // die on the parameter ceiling for exactly the large sheets that need it.
    const stale: number[] = [];
    for (const row of rows) {
      if (!byIndex.has(row.rowIndex)) stale.push(row.rowIndex);
    }
    const DELETE_CHUNK = 5_000;
    for (let index = 0; index < stale.length; index += DELETE_CHUNK) {
      await tx
        .delete(sheetRows)
        .where(
          and(
            eq(sheetRows.tabId, tab.id),
            inArray(sheetRows.rowIndex, stale.slice(index, index + DELETE_CHUNK))
          )
        );
    }

    await persistRows(tab.id, ref.pageId, byIndex, tx, 'replace');

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
  exec: Executor,
  forUpdate = false
): Promise<Map<number, StoredRow>> {
  const map = new Map<number, StoredRow>();
  if (indexes.length === 0) return map;

  // Chunked: `inArray` emits one bind parameter per index, and a caller with
  // tens of thousands of them would hit the 65535 ceiling as a protocol error.
  const CHUNK = 5_000;
  for (let index = 0; index < indexes.length; index += CHUNK) {
    const slice = indexes.slice(index, index + CHUNK);
    let query = exec
      .select({ rowIndex: sheetRows.rowIndex, cells: sheetRows.cells })
      .from(sheetRows)
      .where(and(eq(sheetRows.tabId, tabId), inArray(sheetRows.rowIndex, slice)))
      .limit(slice.length)
      .$dynamic();

    // Rows a caller intends to WRITE are locked, so two concurrent edits to
    // the same row serialise rather than interleaving into a lost update. Rows
    // loaded only as formula inputs are not locked — that would turn a read of
    // a wide range into a lock on a large slice of the sheet.
    if (forUpdate) query = query.for('update');

    const rows = await query;

    for (const row of rows) {
      map.set(row.rowIndex, { rowIndex: row.rowIndex, cells: { ...(row.cells ?? {}) } });
    }
  }
  return map;
}

/** A contiguous, inclusive run of row indexes. */
interface RowSpan {
  start: number;
  end: number;
}

/**
 * Merge overlapping and adjacent spans, so a fan of small ranges over the same
 * region becomes one predicate rather than dozens.
 */
function coalesceSpans(spans: readonly RowSpan[]): RowSpan[] {
  const sorted = spans
    .filter((span) => span.end >= span.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (sorted.length === 0) return [];

  const merged: RowSpan[] = [{ ...sorted[0] }];
  for (const span of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    // `<= last.end + 1` so touching spans join: rows 1-3 and 4-6 are one read.
    if (span.start <= last.end + 1) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * Load every row covered by `spans` that is not already present.
 *
 * Two bind parameters per span regardless of its width, and the spans
 * themselves are chunked, so no sheet size can overrun the statement's
 * parameter budget.
 */
async function mergeMissingSpans(
  target: Map<number, StoredRow>,
  tabId: string,
  spans: readonly RowSpan[],
  exec: Executor
): Promise<void> {
  const merged = coalesceSpans(spans);
  if (merged.length === 0) return;

  const SPANS_PER_QUERY = 200;
  for (let index = 0; index < merged.length; index += SPANS_PER_QUERY) {
    const chunk = merged.slice(index, index + SPANS_PER_QUERY);
    const predicate = sql.join(
      chunk.map(
        (span) => sql`(${sheetRows.rowIndex} >= ${span.start} AND ${sheetRows.rowIndex} <= ${span.end})`
      ),
      sql` OR `
    );

    const rows = await exec
      .select({ rowIndex: sheetRows.rowIndex, cells: sheetRows.cells })
      .from(sheetRows)
      .where(and(eq(sheetRows.tabId, tabId), sql`(${predicate})`))
      .orderBy(asc(sheetRows.rowIndex))
      .limit(MAX_INPUT_ROWS + 1);

    // Same reasoning as the closure cap: a truncated input set makes a `SUM`
    // quietly compute and persist the wrong number.
    if (rows.length > MAX_INPUT_ROWS) {
      throw new Error(
        `Formula inputs reached ${MAX_INPUT_ROWS} rows; narrow the range or rebuild the sheet`
      );
    }

    for (const row of rows) {
      if (target.has(row.rowIndex)) continue;
      target.set(row.rowIndex, { rowIndex: row.rowIndex, cells: { ...(row.cells ?? {}) } });
    }
  }
}

/**
 * Load rows that are not already present, without disturbing pending edits.
 *
 * Merging rather than overwriting is the point: a row already in `target` may
 * carry uncommitted changes from this same call, and re-reading it from the
 * database would discard them.
 */
async function mergeMissingRows(
  target: Map<number, StoredRow>,
  tabId: string,
  indexes: number[],
  exec: Executor,
  forUpdate = false
): Promise<void> {
  const missing = indexes.filter((index) => !target.has(index));
  if (missing.length === 0) return;

  const loaded = await loadRowsByIndex(tabId, missing, exec, forUpdate);
  for (const [index, row] of loaded) target.set(index, row);
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
    // `dependents` is deliberately not maintained here.
    //
    // The closure walk resolves dependents by querying `dependsOn && frontier`,
    // so the column is never read. Populating it incrementally would mean
    // touching every cell that references the one being edited — the O(sheet)
    // write this design removes. See the schema note.
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
      .limit(MAX_RECOMPUTE_CLOSURE + 1);

    const positions = frontier.map((address) => decodeCellAddress(address));
    const viaRange = positions.length
      ? await exec
          .select({ address: sheetRangeDeps.formulaAddress })
          .from(sheetRangeDeps)
          .where(and(eq(sheetRangeDeps.tabId, tabId), rangeCovers(positions)))
          .limit(MAX_RECOMPUTE_CLOSURE + 1)
      : [];

    const next: string[] = [];
    for (const { address } of [...direct, ...viaRange]) {
      const normalized = address.toUpperCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      closure.add(normalized);
      next.push(normalized);
    }

    // `>=`, and the queries above fetch one past the cap, so hitting the limit
    // THROWS rather than silently returning a truncated frontier. Truncating
    // would leave dependents holding stale materialised values that later reads
    // return as though they were correct — a wrong answer presented as a right
    // one, which is worse than a failed write.
    if (closure.size >= MAX_RECOMPUTE_CLOSURE) {
      throw new Error(
        `Recompute closure reached ${MAX_RECOMPUTE_CLOSURE} cells; rebuild the sheet instead`
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

  // Parenthesised as a whole. Without this the caller's
  // `and(eq(tabId, ...), rangeCovers(...))` renders as
  //   "tabId" = $1 AND (clause1) OR (clause2) OR ...
  // and because AND binds tighter than OR, every clause after the first escapes
  // the tab filter and matches range dependencies in other tabs — and other
  // pages. Any multi-cell edit would then pull foreign formula addresses into
  // this tab's recompute closure.
  return sql`(${sql.join(clauses, sql` OR `)})`;
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

  const targets = new Set(addresses.map((a) => a.toUpperCase()));

  // `loaded` is read-only scaffolding for the evaluation. It is deliberately
  // NOT the map the caller persists: it holds input rows that this call has no
  // business rewriting.
  const loaded = new Map<number, StoredRow>(pending);

  // Every recomputed formula must be READ before its inputs can be known, and
  // a formula in an untouched row is not in `pending`. Reading the formula text
  // only from `pending` was silently wrong: a dependent's inputs living in
  // other rows were never loaded, so they evaluated as empty and the dependent
  // was materialised with a plausible but incorrect value.
  const formulaRowIndexes = unique(addresses.map((address) => decodeCellAddress(address).row));
  await mergeMissingRows(loaded, tab.id, formulaRowIndexes, exec);

  // Ranges stay RANGES here, and that is the whole point.
  //
  // Expanding `SUM(A1:A100000)` into 100,000 row indexes and handing them to an
  // `IN (...)` list rebuilds, in the read path, exactly the problem this design
  // removed from the write path: one bind parameter per row, blowing through
  // Postgres's 65535-parameter ceiling (as an opaque 08P01) on precisely the
  // 100k-row sheet the module exists to support. A span costs two parameters
  // whether it covers three rows or a million.
  const spans: RowSpan[] = formulaRowIndexes.map((row) => ({ start: row, end: row }));
  for (const raw of Object.values(collectRawText(loaded, targets))) {
    const deps = extractFormulaDependencies(raw);
    for (const cell of deps.cells) {
      const row = decodeCellAddress(cell).row;
      spans.push({ start: row, end: row });
    }
    for (const rect of deps.ranges) {
      spans.push({
        start: rect.rowStart,
        end: rect.rowEnd ?? Math.max(tab.rowCount - 1, rect.rowStart),
      });
    }
  }

  await mergeMissingSpans(loaded, tab.id, spans, exec);
  const stored = loaded;

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

  // Stringified, deliberately, and it round-trips.
  //
  // The worry is obvious — a value re-entering evaluation as text could be
  // re-coerced into something else — but it does not happen with this engine.
  // Checked against a full `evaluateSheet` pass for a numeric-looking string
  // (`="7"`) and a boolean, through concatenation, arithmetic, equality and
  // `IF`: every case agrees. The engine coerces on READ (`"7"` compares equal
  // to 7, a literal `007` is already the number 7), so the round trip is
  // lossless where it matters. `sheet-store.integration.test.ts` pins that.
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

    // Never fabricate a row here. `persistRows` replaces a row's whole `cells`
    // object, so writing a row that was not loaded in full would delete every
    // column this call never saw. The caller loads every row it intends to
    // write; a miss is a bug in that contract, not something to paper over.
    const row = rows.get(rowIndex);
    if (!row) continue;

    const label = encodeColumnLabel(column);

    // Never fabricate a CELL either. A closure can name an address whose cell
    // no longer exists — a stale dependency edge, or a row that shifted under a
    // structural change — and inventing one would write a phantom with a
    // computed value and no text anybody authored.
    const existing = row.cells[label];
    if (!existing) continue;

    row.cells[label] = {
      ...existing,
      value: result.value,
      type: result.type,
      ...(result.error ? { error: { type: result.error } } : {}),
    };
    if (!result.error) delete row.cells[label].error;
  }
}

/**
 * @param mode `'merge'` contributes only the keys the caller touched, so a
 * concurrent write to a different column of the same row survives. `'replace'`
 * writes the row's cells verbatim — required by the repair path, which is the
 * only caller that legitimately needs a cell to DISAPPEAR, and which holds the
 * whole row anyway.
 */
async function persistRows(
  tabId: string,
  pageId: string,
  rows: Map<number, StoredRow>,
  exec: Executor,
  mode: 'merge' | 'replace' = 'merge'
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
        set: {
          // MERGE by default, not replace.
          //
          // `excluded.cells` alone loses concurrent writes: two callers each
          // set a different column of the same row, both read the row, both
          // write back their own merged copy, and the second commit erases the
          // first cell — with a success returned to both. `||` is a jsonb
          // shallow merge, so each write contributes only the keys it actually
          // touched and columns it never saw survive.
          //
          // The keys this statement carries are exactly the cells the caller
          // wrote plus those it recomputed, so a merge cannot resurrect a cell
          // that was legitimately removed within the same call.
          cells:
            mode === 'replace'
              ? sql`excluded."cells"`
              : sql`${sheetRows.cells} || excluded."cells"`,
          updatedAt: new Date(),
        },
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

/**
 * Bump the page's revision and mtime after a row write.
 *
 * The sheet editor holds an `expectedRevision` and sends it on save. A row
 * write that leaves the revision alone is therefore INVISIBLE to that guard: a
 * form submission or an MCP cell write landing while somebody has the sheet
 * open would pass the check, and `replaceFromDocument` would then delete every
 * row absent from the editor's stale document. Bumping here restores the
 * conflict the old document path produced.
 */
async function touchPage(pageId: string, exec: Executor): Promise<void> {
  await exec
    .update(pages)
    .set({ revision: sql`${pages.revision} + 1`, updatedAt: new Date() })
    .where(eq(pages.id, pageId));
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
  tabId: string | null,
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
