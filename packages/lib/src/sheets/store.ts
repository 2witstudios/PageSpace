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
import type { SheetData, SheetCellUpdate, CellFormat } from './types';
import {
  MAX_ADDRESSABLE_ROW,
  MAX_ADDRESSABLE_COLUMN,
  decodeCellAddress,
  encodeColumnLabel,
  decodeColumnLabel,
} from './address';
import { extractFormulaDependencies } from './deps';
import { sheetRowMatchesIlike, sheetRowMatchesRegex } from './search-sql';
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
  planFormatOps,
  parseRangeSpan,
  SheetFormatError,
  MAX_FORMAT_OPS,
  MAX_FORMAT_CELLS_PER_REQUEST,
  type SheetFormatOp,
  type SheetFormatPlan,
  type SheetFormatTarget,
  type RangeSpan,
} from './format-request';
import { parseConditionalRules, type ConditionalRule } from './conditional';
import { parseRegions, type SheetRegion } from './regions';
import { setColumnFormat, setColumnWidth, setRowHeight, setFrozen } from './format-ops';
import { isEmptyFormat } from './format';
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

/**
 * A caller-supplied address that cannot be stored.
 *
 * Typed so the API layer can answer 400 rather than 500. `isValidCellAddress`
 * accepts `A0` and `A9999999999` — both match `/^[A-Z]+\d+$/` — so they clear
 * every route-level check and only fail here, and an agent that receives
 * "Sheet operation failed" has no way to correct itself.
 */
export class SheetAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetAddressError';
  }
}

export interface SheetActor {
  userId?: string | null;
  actorEmail?: string | null;
  actorDisplayName?: string | null;
  driveId?: string | null;
  resourceTitle?: string | null;
  /** Free-form provenance for the activity entry (source, operation, counts). */
  metadata?: Record<string, unknown> | null;
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
  exec?: Executor
): Promise<StoredTab & { id: string }> {
  const runner = exec ?? db;
  const existing = await getTab(ref, runner);
  if (existing) return existing;

  const tabIndex = ref.tabIndex ?? 0;
  const [page] = await runner
    .select({ content: pages.content })
    .from(pages)
    .where(eq(pages.id, ref.pageId))
    .limit(1);

  if (!page) throw new Error(`Page ${ref.pageId} not found`);

  // Materialisation must be ATOMIC.
  //
  // `materializeFromDocument` treats a supplied executor as "already inside a
  // transaction". When `ensureTab` is called without one — the lazy-migration
  // entry point for MCP reads — passing `db` made every statement autocommit:
  // the `FOR UPDATE` on the page released immediately, so two concurrent reads
  // could both pass the has-tabs check and the second died on the unique
  // constraint; and a failure part-way through the per-tab loop committed a
  // tab with partial rows. After that `getTab` succeeds, so every reader takes
  // the row path and the intact document is never consulted again — a silent,
  // permanent truncation.
  //
  // Passing `exec` only when the caller genuinely supplied one lets
  // `materializeFromDocument` open its own transaction otherwise.
  await materializeFromDocument(ref.pageId, page.content ?? '', exec);

  const created = await getTab({ pageId: ref.pageId, tabIndex }, runner);
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
        conditionalFormats: tab.conditionalFormats,
        regions: tab.regions,
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
          conditionalFormats: materialized.tab.conditionalFormats,
          regions: materialized.tab.regions,
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

/** One row rendered as a line of text: computed values, else authored text. */
function rowText(cells: Record<string, StoredCell> | null | undefined): string {
  return Object.keys(cells ?? {})
    .sort()
    .map((label) => {
      const cell = cells![label];
      const value = cell.value !== undefined && cell.value !== '' ? cell.value : cell.raw;
      return String(value ?? '');
    })
    .filter(Boolean)
    .join(' ');
}

/** A matched row, rendered for a search result excerpt. */
export interface MatchingRowText {
  /** Zero-based; callers showing a row number add one. */
  rowIndex: number;
  text: string;
}

export type SheetRowMatch = { ilike: string | readonly string[] } | { regex: string };

/**
 * The rows that actually matched a search, for EVERY page at once.
 *
 * A result list needs to quote WHERE the query hit, and a bounded preview of
 * the first N rows cannot: a match at row 5,000, on a later tab, or past the
 * character cap falls outside it, so the search reported a spreadsheet as a hit
 * with nothing to show and a match count of zero. The match runs in SQL against
 * the same cell-value expression the page-level predicate uses, so the rows
 * returned are exactly the rows that made each page match.
 *
 * Batched because the callers are result loops. One query per visible sheet
 * meant search latency grew linearly with the number of matching spreadsheets —
 * and multi-drive search allows up to 50 results per accessible drive. A
 * window function applies the per-page cap inside the single query, so the
 * bound is the same as the per-page form and the row count returned stays
 * `pages × limit` no matter how large the sheets are.
 */
export async function sheetMatchingRowsByPage(
  pageIds: readonly string[],
  match: SheetRowMatch,
  options: { limit?: number; maxChars?: number } = {},
  exec: Executor = db
): Promise<Map<string, MatchingRowText[]>> {
  const byPage = new Map<string, MatchingRowText[]>();
  if (pageIds.length === 0) return byPage;

  const limit = Math.min(Math.max(options.limit ?? 5, 1), 50);
  const maxChars = options.maxChars ?? 200;

  const predicate =
    'ilike' in match ? sheetRowMatchesIlike(match.ilike) : sheetRowMatchesRegex(match.regex);

  // `row_number()` rather than a per-page LIMIT: one statement, and the cap is
  // applied per page rather than across the whole result, so one enormous sheet
  // cannot crowd every other page out of the excerpts.
  const ranked = exec
    .select({
      pageId: sheetRows.pageId,
      rowIndex: sheetRows.rowIndex,
      cells: sheetRows.cells,
      rank: sql<number>`row_number() OVER (
        PARTITION BY ${sheetRows.pageId} ORDER BY ${sheetRows.rowIndex} ASC
      )`.as('rank'),
    })
    .from(sheetRows)
    .where(and(inArray(sheetRows.pageId, [...pageIds]), predicate))
    .as('ranked');

  const found = await exec
    .select({ pageId: ranked.pageId, rowIndex: ranked.rowIndex, cells: ranked.cells })
    .from(ranked)
    .where(sql`${ranked.rank} <= ${limit}`)
    .orderBy(asc(ranked.pageId), asc(ranked.rowIndex));

  for (const row of found) {
    const text = rowText(row.cells).slice(0, maxChars);
    if (text === '') continue;
    const existing = byPage.get(row.pageId);
    if (existing) existing.push({ rowIndex: row.rowIndex, text });
    else byPage.set(row.pageId, [{ rowIndex: row.rowIndex, text }]);
  }

  return byPage;
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
    // `getTab`, not `ensureTab`.
    //
    // The loop below writes every tab the incoming document describes, so
    // materialising the OLD document first is pure waste — it parses,
    // fully evaluates and inserts every row of the previous content only to
    // delete and replace it, doubling the cost of the most expensive save
    // there is (the first save of a large pre-migration sheet).
    //
    // It also made a sheet whose stored document no longer parses impossible
    // to save over: `ensureTab` would throw on the old content and reject the
    // very write that would have replaced it.
    const sheets = documentTabs(content);

    let rowTotal = 0;
    for (const [tabIndex, sheet] of sheets.entries()) {
      const tab = await ensureTabAt(ref.pageId, tabIndex, sheet, tx);

      // Tab BEFORE rows, matching `appendRows`, `deleteRows` and the growing
      // branch of `setCells`. This function deletes and upserts rows and then
      // updates the tab, so without taking the tab first an editor autosave
      // concurrent with a form submission or an MCP append is a lock cycle —
      // Postgres aborts one with 40P01, and for a public form submission that
      // means the submitted data is lost.
      await tx.select({ id: sheetTabs.id }).from(sheetTabs).where(eq(sheetTabs.id, tab.id)).for('update');

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

      // EVERY tab-level field, not just the extent.
      //
      // The document carries the sheet's name, freezes, column formats and
      // widths, row heights and named ranges, and this is the path every editor
      // save takes. Persisting only `rowCount`/`columnCount` meant renaming a
      // sheet, freezing panes, resizing a column or setting a column format
      // appeared to work and then reverted on reload.
      await tx
        .update(sheetTabs)
        .set({
          name: materialized.tab.name,
          rowCount: materialized.tab.rowCount,
          columnCount: materialized.tab.columnCount,
          frozenRows: materialized.tab.frozenRows,
          frozenColumns: materialized.tab.frozenColumns,
          columnFormats: materialized.tab.columnFormats,
          columnWidths: materialized.tab.columnWidths,
          rowHeights: materialized.tab.rowHeights,
          ranges: materialized.tab.ranges,
          conditionalFormats: materialized.tab.conditionalFormats,
          regions: materialized.tab.regions,
          updatedAt: new Date(),
        })
        .where(eq(sheetTabs.id, tab.id));

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

    // 1. Walk to the closure of formulas whose inputs moved.
    //
    // Reads only the dirty ADDRESSES, so no row has to be read first — which is
    // what lets every row be read once, under the lock, in step 3.
    //
    // Resolved BEFORE the locks, because the locks are derived from it: the set
    // of rows to lock is exactly the touched rows plus the closure's. That
    // leaves one narrow race. If another transaction CREATES a formula
    // referencing a cell this call is writing, in a DIFFERENT row, after this
    // query's snapshot and before this call commits, the new formula is not in
    // this closure and its author evaluated it against the pre-write value — so
    // it keeps a stale result until something touches it again.
    //
    // Same-row is safe, which covers the common shape (`=A1*2` beside `A1`):
    // one `sheet_rows` row holds both, so the row lock serialises the two
    // writers and the second re-reads. The document path is safe too — it
    // rewrites every row. Closing the cross-row case would mean re-resolving
    // after locking and then acquiring more row locks out of order, which
    // trades a rare stale value for a real deadlock, so it is left open
    // deliberately rather than half-fixed.
    const touchedRowIndexes = unique(normalized.map((u) => u.position.row));
    const dirty = normalized.map((u) => u.address);
    const closure = await resolveDependentClosure(tab.id, dirty, tx);

    // 3. Lock the whole union ascending — the ONE acquisition point — and only
    // then read the rows this call will write.
    //
    // A single ordered acquisition is what makes deadlock impossible; two
    // ordered statements are not globally ordered, because a closure row can
    // sit below a touched one.
    //
    // Reading AFTER the lock also matters on its own. An earlier version read
    // the touched rows first, unlocked, and merged the pending edits over the
    // re-read — but the pending row carried the whole STALE row, so a column
    // another transaction had written in between was overwritten by the stale
    // copy. That is the lost update the row lock exists to prevent,
    // reintroduced above it.
    const closureRowIndexes = unique(closure.map((address) => decodeCellAddress(address).row));
    const allRowIndexes = unique([...touchedRowIndexes, ...closureRowIndexes]);

    // TAB BEFORE ROWS — the order every function here uses — but only when this
    // write will actually touch the tab.
    //
    // The ordering matters because `appendRows` and `deleteRows` lock the tab
    // and then reach row locks; `setCells` taking rows first and the tab later
    // deadlocks against them. Taking the tab UNCONDITIONALLY fixes that but
    // serialises every write to the sheet behind one exclusive lock — which
    // would undo the concurrency this whole storage model exists to provide,
    // most visibly for a form taking simultaneous submissions.
    //
    // `growExtent` depends only on the tab's declared extent and the incoming
    // addresses, both known here, so whether the tab will be written is
    // decidable before any lock is taken. Computing it from a possibly-stale
    // `tab.rowCount` is safe: if it says "no growth" then nothing writes the
    // tab either, so there is nothing to serialise.
    const grown = growExtent(tab, normalized);
    if (grown) {
      await tx.select({ id: sheetTabs.id }).from(sheetTabs).where(eq(sheetTabs.id, tab.id)).for('update');
    }
    await lockRows(tab.id, allRowIndexes, tx);

    // `working` is the set of rows this call may WRITE, every one of them read
    // whole under the lock. `persistRows` upserts the entire `cells` object, so
    // writing a row that was only partially loaded would delete every column it
    // did not know about.
    const working = await loadRowsByIndex(tab.id, allRowIndexes, tx, false);

    // 3b. Re-derive the dependency edges, UNDER the lock.
    //
    // Rewriting them before any lock let two writers to the same formula cell
    // race: the second's DELETE waits on the first, then re-evaluates and finds
    // the old row gone — but the first's freshly inserted row is invisible to
    // its snapshot, so the INSERT violates the primary key (23505, a 500). The
    // `sheet_range_deps` half has a surrogate id instead, so it silently
    // accumulated duplicate rectangles that widened every later closure.
    await rewriteDependencyEdges(tab.id, normalized, tx);

    // 4. Apply the authored text on top of what the lock guarantees is current.
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

    // 5. Evaluate the dirty cells and that closure, and nothing else.
    const toEvaluate = unique([...dirty, ...closure]);
    const evaluated = await evaluateClosure(tab, toEvaluate, working, tx);

    // 6. Persist.
    applyEvaluation(working, evaluated);
    await persistRows(tab.id, ref.pageId, working, tx);
    if (grown) {
      // The tab lock is already held (taken before the row locks above), so the
      // re-read below cannot race another growing write. `updateExtent` writes
      // an ABSOLUTE extent computed from a snapshot, so without that
      // serialisation two concurrent growing writes lose one and the declared
      // extent ends up smaller than the data.
      const current = await getTab(ref, tx);
      await updateExtent(
        tab.id,
        {
          rowCount: Math.max(grown.rowCount, current?.rowCount ?? 0),
          columnCount: Math.max(grown.columnCount, current?.columnCount ?? 0),
        },
        tx
      );
    }
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

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export interface ApplyFormatOpsResult {
  /** Cells whose stored `format` changed. */
  cellsFormatted: number;
  /**
   * `sheet_rows` rows this call wrote, formulas re-evaluated for growth
   * included.
   *
   * Reported because a stored value cannot show it: `A1` being bold after a
   * call looks identical whether the call wrote one row or rewrote fifty
   * thousand. A caller — and the test that pins this — asserts the write was
   * O(touched) from this number.
   */
  rowsTouched: number;
  /** The `sheet_tabs` columns whose stored value changed, by column name. */
  tabFieldsChanged: string[];
  /** Conditional rules on the tab after the write. */
  conditionalRules: number;
  /** Regions on the tab after the write. */
  regions: number;
  rowCount: number;
  columnCount: number;
  /**
   * Formulas re-evaluated because the extent grew. Empty for every other
   * format write — see the growth note in `applyFormatOps`.
   */
  recomputed: string[];
}

/**
 * The `sheet_tabs` columns a format write may touch, in the order the change
 * log reports them. `rowCount`/`columnCount` are here because growth is a
 * format write's side effect on the same row.
 */
const TAB_FORMAT_FIELDS = [
  'columnFormats',
  'columnWidths',
  'rowHeights',
  'frozenRows',
  'frozenColumns',
  'conditionalFormats',
  'regions',
  'rowCount',
  'columnCount',
] as const;

type TabFormatField = (typeof TAB_FORMAT_FIELDS)[number];

/**
 * Values for those columns. A field absent from the object is one the write
 * does not touch; `null` is an explicit "store nothing", which is what the
 * document path writes for an empty map or list.
 */
interface TabFieldValues {
  columnFormats?: Record<string, CellFormat> | null;
  columnWidths?: Record<string, number> | null;
  rowHeights?: Record<string, number> | null;
  frozenRows?: number | null;
  frozenColumns?: number | null;
  conditionalFormats?: ConditionalRule[] | null;
  regions?: SheetRegion[] | null;
  rowCount?: number;
  columnCount?: number;
}

/**
 * Apply presentation edits — cell formats, column defaults, widths, heights,
 * freezes, conditional rules, regions — and nothing else.
 *
 * The write path for everything `format-ops` can express, which until now had
 * only browser callers: an agent could set a cell's value and not one thing
 * about how it looked. Validation is `planFormatOps`'s job and every refusal
 * is a `SheetFormatError`; this function is the persistence that plan
 * describes, and it deliberately second-guesses none of it. The plan runs once
 * on a snapshot, so a bad request costs no lock, and again under the lock, so
 * a request the tab has moved out from under — a rule id another writer just
 * took — is refused and rolled back rather than written over.
 *
 * Persistence is split. A cell's own format lives on its row in
 * `sheet_rows.cells`, so a per-cell op is a row write scoped to the rows the
 * plan names — formatting `A1:H1` on a 50,000-row sheet reads, locks and
 * writes one row. Everything else lives on the tab record and is written as
 * ONE `UPDATE` however many ops asked for it: an editor holding the sheet open
 * sees one conflict, not one per op.
 *
 * Ops may address past the declared extent, and the sheet GROWS to cover them
 * — the decision `edit_sheet_cells` already made for values, applied to
 * formats. Growth carries an obligation the write would otherwise skip:
 * `evaluateClosure` resolves an open range's end from `rowCount`, so a formula
 * over `A:A` means something different once the sheet is taller, and a format
 * write does no recompute of its own. On growth, every formula holding an
 * open-ended range edge is re-evaluated along with its dependents.
 *
 * Today that set is always empty: `FormulaParser.parseRange` rejects `A:A`,
 * so no storable formula reads the extent (see the `deps.ts` module doc) and
 * `sheet_range_deps` never holds a NULL bound through any write path. The
 * recompute is kept as the contract growth owes, so the day open ranges parse
 * this path does not start presenting stale totals as correct. When the extent
 * does not grow no value can change — the evaluator's sheet carries no formats
 * and `StoredCell` has no rendered form — so no recompute runs.
 */
export async function applyFormatOps(
  ref: TabRef,
  ops: readonly SheetFormatOp[],
  actor: SheetActor = {},
  exec?: Executor
): Promise<ApplyFormatOpsResult> {
  const run = async (tx: Executor): Promise<ApplyFormatOpsResult> => {
    const tab = await ensureTab(ref, tx);

    // 1. Validate and plan, before any lock.
    //
    // Everything a request can be refused for on its own is refused here, on
    // the pre-lock snapshot, so a bad request costs no transaction time. (The
    // re-plan in step 4 can still refuse, when the tab moved in between.) The
    // plan is also what the locks are derived from: `plan.rows` is exactly the
    // set of `sheet_rows` a per-cell op will write, and the tab-field flag and
    // the extent decision below settle whether the tab record is written at
    // all.
    const preview = planFormatOps(ops, formatTarget(tab));
    const rowIndexes = Array.from(preview.rows);
    const growth = formatGrowth(tab, preview);

    if (rowIndexes.length === 0 && !preview.touchesTabFields && !growth) {
      // Nothing to write, so nothing to lock, bump or log.
      return {
        cellsFormatted: 0,
        rowsTouched: 0,
        tabFieldsChanged: [],
        conditionalRules: preview.conditionalFormats.length,
        regions: preview.regions.length,
        rowCount: tab.rowCount,
        columnCount: tab.columnCount,
        recomputed: [],
      };
    }

    // 2. If the extent grows, resolve what has to be re-evaluated — BEFORE the
    // locks, because the locks are derived from it, exactly as `setCells`
    // resolves its closure. Locking the formula rows later, after the rows
    // this call formats, would be a second ordered acquisition — and two
    // ordered statements are not globally ordered. A `setCells` holding a
    // formula's row while it waits for one of ours is then a cycle.
    //
    // Only formulas with an OPEN-ENDED range are seeded: a bounded rectangle
    // reads the same cells whatever the extent, and the rows a format op
    // creates carry no values. The narrow race `setCells` documents applies
    // here too — a formula created concurrently in another row after this
    // snapshot keeps a stale result until something touches it.
    let recomputeTargets: string[] = [];
    if (growth) {
      const open = await openRangeFormulas(tab.id, tx);
      if (open.length > 0) {
        const closure = await resolveDependentClosure(tab.id, open, tx);
        recomputeTargets = unique([...open, ...closure]);
      }
    }
    const recomputeRowIndexes = unique(
      recomputeTargets.map((address) => decodeCellAddress(address).row)
    );
    const allRowIndexes = unique([...rowIndexes, ...recomputeRowIndexes]);

    // 3. TAB BEFORE ROWS, and only when this write will touch the tab — the
    // same conditional order `setCells` uses, for the same two reasons.
    // `appendRows`, `deleteRows` and `replaceFromDocument` all take the tab
    // first and then reach rows, so rows-then-tab is a deadlock against every
    // one of them; and taking the tab unconditionally would serialise every
    // write to the sheet behind one exclusive lock, undoing the concurrency
    // the row store exists to provide. Whether the tab will be written is
    // decidable from the ops and the extent, both known here.
    const touchesTab = preview.touchesTabFields || growth !== null;
    if (touchesTab) {
      await tx.select({ id: sheetTabs.id }).from(sheetTabs).where(eq(sheetTabs.id, tab.id)).for('update');
    }
    await lockRows(tab.id, allRowIndexes, tx);

    // 4. Re-read UNDER the lock and plan again against what is actually there.
    //
    // The `tab` from `ensureTab` is a snapshot taken before any lock. A rule
    // another transaction added while this one waited for the tab is absent
    // from it, and a plan built on it would write a rule list without that
    // rule — a lost update with a success returned to both. Planning twice is
    // pure and bounded; the second plan is the one that is written, and the
    // first exists only to decide what to lock. Rows depend on the ops alone,
    // so the two agree on what was locked.
    const current = await getTab(ref, tx);
    if (!current) throw new Error(`Sheet tab not found for page ${ref.pageId}`);
    const plan = planFormatOps(ops, formatTarget(current));

    // Growth is re-derived from the locked extent, and only if the snapshot
    // said so: if it did not, no tab lock is held and the recompute seeds were
    // never resolved, and the window where the extent SHRANK in between is
    // the same one `setCells` accepts rather than acquiring more locks out of
    // order for it.
    const grown = growth ? formatGrowth(current, plan) : null;
    const extent = {
      rowCount: grown?.rowCount ?? current.rowCount,
      columnCount: grown?.columnCount ?? current.columnCount,
    };

    // 5. Rows. Read whole — the format each cell has now, and the content that
    // has to survive, are both only knowable from the stored cell — but
    // written as PATCHES: `patches` carries, per row, only the columns this
    // call formats, and per column only the format. `persistRows` in
    // `'format'` mode merges that under whatever content the cell holds when
    // the statement runs, so a concurrent `setCells` to column A of the same
    // row — or to this very cell, if the row did not exist to be locked —
    // survives in either commit order. That is a lost-update guard, not an
    // optimisation.
    //
    // `lockRows` already holds the locks, so this read takes none.
    const working = await loadRowsByIndex(tab.id, allRowIndexes, tx, false);
    const patches = new Map<number, FormatPatchRow>();
    const stage = <Cell,>(
      map: Map<number, { rowIndex: number; cells: Record<string, Cell> }>,
      rowIndex: number,
      label: string,
      cell: Cell
    ) => {
      let row = map.get(rowIndex);
      if (!row) {
        row = { rowIndex, cells: {} };
        map.set(rowIndex, row);
      }
      row.cells[label] = cell;
    };

    // The format each written cell had before this call, keyed by address in
    // the order cells were first touched. Doubles as the count of cells
    // formatted and as the change log's `before`.
    const before = new Map<string, CellFormat | null>();

    for (const step of plan.steps) {
      if (step.type !== 'setCellFormat' && step.type !== 'clearCellFormat') continue;

      for (const address of step.addresses) {
        const { row: rowIndex, column } = decodeCellAddress(address);
        const label = encodeColumnLabel(column);
        const existing = working.get(rowIndex)?.cells[label];

        const next =
          step.type === 'setCellFormat'
            ? mergeCellFormat(existing?.format, step.patch)
            : undefined;
        if (sameJson(existing?.format, next)) continue;

        // An empty cell has no `StoredCell` to carry a format, so one is
        // created as `{ raw: '', format }`. This round-trips: the projection
        // skips `raw === ''` for `cells` and keeps `formats[address]`.
        //
        // Clearing the last format of such a cell leaves `{ raw: '' }` behind
        // — a tombstone. jsonb `||` cannot delete a key, and the alternative,
        // replace mode, would reintroduce the lost update above to remove an
        // inert object. The tombstone projects to nothing and `rebuildTab`
        // collects it. Do not "fix" this with replace mode.
        const cell: StoredCell = { ...(existing ?? { raw: '' }) };
        if (next) cell.format = next;
        else delete cell.format;

        if (!before.has(address)) before.set(address, existing?.format ?? null);
        stage(working, rowIndex, label, cell);
      }
    }

    // Patches are staged from the NET change, after every step has run: a
    // bold set and cleared again in one request ends where it began, and
    // writing that would create a tombstone row, bump the revision and log an
    // entry whose before and after agree.
    for (const [address, previous] of before) {
      const { row: rowIndex, column } = decodeCellAddress(address);
      const label = encodeColumnLabel(column);
      const cell = working.get(rowIndex)?.cells[label];
      const final = cell?.format ?? null;
      if (sameJson(previous, final)) {
        before.delete(address);
        continue;
      }
      stage(patches, rowIndex, label, { raw: cell?.raw ?? '', format: final });
    }

    // 6. Re-evaluate what growth changed the meaning of. `evaluateClosure`
    // reads the extent from the tab it is handed, so it gets the GROWN one.
    // `applyEvaluation` writes into `working`, whose formula rows were loaded
    // whole; only the cells it re-evaluated are copied into `pending`.
    // Re-evaluated cells are CONTENT, written through the content merge like
    // any other materialised value; a format patch has no way to say "and the
    // value is now 106".
    const recomputedRows = new Map<number, StoredRow>();
    let recomputed: string[] = [];
    if (grown && recomputeTargets.length > 0) {
      const evaluated = await evaluateClosure({ ...current, ...extent }, recomputeTargets, working, tx);
      applyEvaluation(working, evaluated);
      for (const address of Object.keys(evaluated)) {
        const { row: rowIndex, column } = decodeCellAddress(address);
        const label = encodeColumnLabel(column);
        const cell = working.get(rowIndex)?.cells[label];
        // `applyEvaluation` fabricates neither rows nor cells; neither does this.
        if (!cell) continue;
        stage(recomputedRows, rowIndex, label, cell);
        recomputed.push(address);
      }
      recomputed = unique(recomputed);
    }

    // 7. Persist: formats through the per-cell format merge, re-evaluated
    // values through the content merge.
    await persistRows(tab.id, ref.pageId, patches, tx, 'format');
    await persistRows(tab.id, ref.pageId, recomputedRows, tx);
    const rowsTouched = unique([...patches.keys(), ...recomputedRows.keys()]).length;

    // 8. The tab record, in ONE statement.
    //
    // Only the columns whose stored value differs are set, and only if any do:
    // a `setColumnWidth` to the width a column already has is not a write.
    // Rules and regions are compared as the lists the parser produces, so a
    // stored entry the parser drops does not register as a change here — and
    // is not resurrected, because what is written is the parsed list.
    const tabFieldsChanged: TabFormatField[] = [];
    const next: TabFieldValues = touchesTab ? tabFieldsAfter(current, plan, grown) : {};
    if (touchesTab) {
      const patch: TabFieldValues = {};
      for (const field of TAB_FORMAT_FIELDS) {
        if (!(field in next)) continue;
        if (sameJson(currentTabField(current, field), next[field])) continue;
        tabFieldsChanged.push(field);
        Object.assign(patch, { [field]: next[field] });
      }
      if (tabFieldsChanged.length > 0) {
        await tx
          .update(sheetTabs)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(sheetTabs.id, tab.id));
      }
    }

    const result: ApplyFormatOpsResult = {
      cellsFormatted: before.size,
      rowsTouched,
      tabFieldsChanged,
      conditionalRules: plan.conditionalFormats.length,
      regions: plan.regions.length,
      rowCount: extent.rowCount,
      columnCount: extent.columnCount,
      recomputed,
    };

    // A request that changed nothing — a width the column already has, a bold
    // that is already bold, a clear of a cell with nothing to clear — is not
    // an edit. Bumping the revision for it would hand an open editor a
    // conflict over a sheet that did not move, and log a change that is not
    // one. Locks were taken for nothing, which is the honest cost of finding
    // that out under them.
    if (rowsTouched === 0 && tabFieldsChanged.length === 0) return result;

    // 9. Not optional. `replaceFromDocument` rewrites EVERY tab-level field
    // from the editor's document, and it is the only other writer of these
    // fields. An editor that had the sheet open before this call and saves
    // after it would, without the revision bump, pass its conflict check and
    // silently revert everything written above — cell formats included, since
    // its document carries `formats` too.
    await touchPage(ref.pageId, tx);

    // 10. The log. Per cell up to the summary threshold, then one entry: a
    // 5,000-cell range is one act, and 5,000 rows for it is the write
    // amplification the row store removed from the data coming back in the
    // audit trail. Tab-level changes are one entry per field, carrying the
    // whole before/after map — bounded by the column count, never the rows.
    const entries: Parameters<typeof appendChanges>[3] = [];
    if (!actor.suppressCellLog && before.size > 0) {
      const addresses = Array.from(before.keys());
      if (addresses.length > CHANGE_LOG_SUMMARY_THRESHOLD) {
        entries.push({
          op: 'format',
          address: null,
          rowIndex: decodeCellAddress(addresses[0]).row,
          before: null,
          after: {
            cells: addresses.length,
            firstAddress: addresses[0],
            lastAddress: addresses[addresses.length - 1],
          },
        });
      } else {
        for (const address of addresses) {
          const { row: rowIndex, column } = decodeCellAddress(address);
          entries.push({
            op: 'format',
            address,
            rowIndex,
            before: before.get(address) ?? null,
            after: working.get(rowIndex)?.cells[encodeColumnLabel(column)]?.format ?? null,
          });
        }
      }
    }
    for (const field of tabFieldsChanged) {
      entries.push({
        op: TAB_FIELD_LOG_OP[field],
        address: null,
        rowIndex: null,
        before: { [field]: currentTabField(current, field) ?? null },
        after: { [field]: next[field] ?? null },
      });
    }
    await appendChanges(ref.pageId, tab.id, actor, entries, tx);

    return result;
  };

  return exec ? run(exec) : db.transaction(run);
}

export interface ReadTabFormattingOptions {
  /**
   * A1 ranges — `"B2:D40"`, or a single cell — whose per-cell formats to
   * return. Omitted, none are read: they live on the rows, and reading them
   * for a whole sheet is the O(sheet) read this store exists to avoid. Bounded
   * by `MAX_FORMAT_CELLS_PER_REQUEST` across all ranges, the same ceiling a
   * write has.
   */
  ranges?: readonly string[];
}

export interface TabFormatting {
  rowCount: number;
  columnCount: number;
  frozenRows: number | null;
  frozenColumns: number | null;
  /** Column defaults, keyed by column letters. */
  columnFormats: Record<string, CellFormat>;
  columnWidths: Record<string, number>;
  /** Keyed by 1-based row number as a string, as stored. */
  rowHeights: Record<string, number>;
  /** Parsed — what the sheet will actually apply, not the raw column. */
  conditionalFormats: ConditionalRule[];
  regions: SheetRegion[];
  /**
   * Explicit per-cell formats within `options.ranges`, keyed by A1 address.
   * Explicit only: the format in force for a cell also depends on its column
   * default and its region, and `resolveCellFormat` is the one definition of
   * that precedence. A second one here is how the grid and an export come to
   * disagree.
   */
  cellFormats: Record<string, CellFormat>;
}

/**
 * Everything about how a tab looks, in one read.
 *
 * A read, so it never writes: `getTab` rather than `ensureTab`, and an
 * unmigrated sheet answers `null` instead of being materialised on the way
 * past. Rules and regions come back PARSED — a caller that read the raw jsonb
 * and wrote it back would resurrect entries the parser drops on every load.
 *
 * Per-cell formats are read by row span, one statement for every range asked
 * for however many there are, and only the cells inside a requested rectangle
 * are returned.
 */
export async function readTabFormatting(
  ref: TabRef,
  options: ReadTabFormattingOptions = {},
  exec: Executor = db
): Promise<TabFormatting | null> {
  const tab = await getTab(ref, exec);
  if (!tab) return null;

  const cellFormats: Record<string, CellFormat> = {};
  const ranges = options.ranges ?? [];
  // `SheetFormatError`, as on the write side: a route maps one class to 400
  // for the whole formatting surface, and the same bad range must not be a
  // 400 when written and a 500 when read.
  if (ranges.length > MAX_FORMAT_OPS) {
    throw new SheetFormatError(`At most ${MAX_FORMAT_OPS} ranges can be read at once; got ${ranges.length}.`);
  }

  if (ranges.length > 0) {
    const spans: RangeSpan[] = [];
    let cells = 0;
    for (const range of ranges) {
      const span = parseRangeSpan(range);
      if (!span) throw new SheetFormatError(`"${range}" is not a range this sheet can address.`);
      // Counted before anything is read, so the cap bounds the read and not
      // just the result. A one-column range still costs a row per cell.
      cells += (span.rowEnd - span.rowStart + 1) * (span.colEnd - span.colStart + 1);
      if (cells > MAX_FORMAT_CELLS_PER_REQUEST) {
        throw new SheetFormatError(
          `The ranges cover more than ${MAX_FORMAT_CELLS_PER_REQUEST.toLocaleString()} cells between them; narrow them.`
        );
      }
      spans.push(span);
    }

    const rows = new Map<number, StoredRow>();
    await mergeMissingSpans(
      rows,
      tab.id,
      spans.map((span) => ({ start: span.rowStart, end: span.rowEnd })),
      exec
    );

    for (const row of rows.values()) {
      for (const [label, cell] of Object.entries(row.cells)) {
        if (!cell.format) continue;
        const column = decodeColumnLabel(label);
        const inside = spans.some(
          (span) =>
            row.rowIndex >= span.rowStart &&
            row.rowIndex <= span.rowEnd &&
            column >= span.colStart &&
            column <= span.colEnd
        );
        if (inside) cellFormats[`${label}${row.rowIndex + 1}`] = cell.format;
      }
    }
  }

  return {
    rowCount: tab.rowCount,
    columnCount: tab.columnCount,
    frozenRows: tab.frozenRows ?? null,
    frozenColumns: tab.frozenColumns ?? null,
    columnFormats: tab.columnFormats ?? {},
    columnWidths: tab.columnWidths ?? {},
    rowHeights: tab.rowHeights ?? {},
    conditionalFormats: parseConditionalRules(tab.conditionalFormats ?? undefined) ?? [],
    regions: parseRegions(tab.regions ?? undefined) ?? [],
    cellFormats,
  };
}

/**
 * The tab as `planFormatOps` wants to see it: rules and regions parsed, so the
 * plan is checked against — and folds its edits into — the list the sheet
 * actually applies rather than whatever the column holds.
 */
function formatTarget(tab: StoredTab): SheetFormatTarget {
  return {
    rowCount: tab.rowCount,
    columnCount: tab.columnCount,
    conditionalFormats: parseConditionalRules(tab.conditionalFormats ?? undefined) ?? [],
    regions: parseRegions(tab.regions ?? undefined) ?? [],
  };
}

/**
 * The extent a plan needs, or null if the tab already covers it.
 *
 * Cells, columns and row heights past the extent grow it; a rule's ranges and
 * a region do not. Both are declared over rows that do not exist yet by
 * design — a region's whole point is to cover the table as it grows — and a
 * declaration is not a request for the rows to exist.
 */
function formatGrowth(
  tab: StoredTab,
  plan: SheetFormatPlan
): { rowCount: number; columnCount: number } | null {
  let rowCount = tab.rowCount;
  let columnCount = tab.columnCount;

  for (const row of plan.rows) rowCount = Math.max(rowCount, row + 1);

  for (const step of plan.steps) {
    switch (step.type) {
      case 'setCellFormat':
      case 'clearCellFormat':
        for (const address of step.addresses) {
          columnCount = Math.max(columnCount, decodeCellAddress(address).column + 1);
        }
        break;
      case 'setColumnFormat':
      case 'setColumnWidth':
        columnCount = Math.max(columnCount, step.columnIndex + 1);
        break;
      case 'setRowHeight':
        rowCount = Math.max(rowCount, step.rowIndex + 1);
        break;
      default:
        break;
    }
  }

  return rowCount === tab.rowCount && columnCount === tab.columnCount
    ? null
    : { rowCount, columnCount };
}

/**
 * Every formula on the tab that reads an open-ended range — `A:A`, `3:3` —
 * whose meaning depends on the declared extent. Always empty today; see the
 * growth note on `applyFormatOps`.
 */
async function openRangeFormulas(tabId: string, exec: Executor): Promise<string[]> {
  const found = await exec
    .select({ address: sheetRangeDeps.formulaAddress })
    .from(sheetRangeDeps)
    .where(
      and(
        eq(sheetRangeDeps.tabId, tabId),
        sql`(${sheetRangeDeps.rowEnd} IS NULL OR ${sheetRangeDeps.colEnd} IS NULL)`
      )
    )
    .limit(MAX_RECOMPUTE_CLOSURE + 1);

  // The same ceiling `resolveDependentClosure` enforces, and for the same
  // reason: silently recomputing a truncated set would leave stale values
  // presented as correct.
  if (found.length > MAX_RECOMPUTE_CLOSURE) {
    throw new Error(
      `Recompute closure reached ${MAX_RECOMPUTE_CLOSURE} cells; rebuild the sheet instead`
    );
  }

  return unique(found.map((row) => row.address.toUpperCase()));
}

/**
 * The tab-level fields as they will be after `plan`, computed by running the
 * plan's tab steps through `format-ops` — the single mutation surface for
 * these maps, so clamping and "delete the key when cleared" are defined once.
 * A field the plan does not touch is absent, not null.
 *
 * Empty maps and lists are stored as `null`, matching what the document path
 * writes for a sheet that has none.
 */
function tabFieldsAfter(
  current: StoredTab,
  plan: SheetFormatPlan,
  grown: { rowCount: number; columnCount: number } | null
): TabFieldValues {
  let sheet: SheetData = {
    version: 0,
    rowCount: current.rowCount,
    columnCount: current.columnCount,
    cells: {},
    columnFormats: current.columnFormats ?? undefined,
    columnWidths: current.columnWidths ?? undefined,
    rowHeights: current.rowHeights ?? undefined,
    frozenRows: current.frozenRows ?? undefined,
    frozenColumns: current.frozenColumns ?? undefined,
  };

  const next: TabFieldValues = {};
  for (const step of plan.steps) {
    switch (step.type) {
      case 'setColumnFormat':
        sheet = setColumnFormat(sheet, step.columnIndex, step.patch);
        next.columnFormats = sheet.columnFormats ?? null;
        break;
      case 'setColumnWidth':
        sheet = setColumnWidth(sheet, step.columnIndex, step.width);
        next.columnWidths = sheet.columnWidths ?? null;
        break;
      case 'setRowHeight':
        sheet = setRowHeight(sheet, step.rowIndex, step.height);
        next.rowHeights = sheet.rowHeights ?? null;
        break;
      case 'setFrozen':
        sheet = setFrozen(sheet, step.rows, step.columns);
        next.frozenRows = sheet.frozenRows ?? null;
        next.frozenColumns = sheet.frozenColumns ?? null;
        break;
      case 'setConditionalRules':
        next.conditionalFormats = step.rules.length > 0 ? [...step.rules] : null;
        break;
      case 'setRegions':
        next.regions = step.regions.length > 0 ? [...step.regions] : null;
        break;
      default:
        break;
    }
  }

  if (grown) {
    next.rowCount = grown.rowCount;
    next.columnCount = grown.columnCount;
  }

  return next;
}

/**
 * A tab field as it is stored, normalised for comparison: rules and regions
 * through the parser (what the sheet applies), everything else as-is with
 * "absent" and `null` the same thing.
 */
function currentTabField(tab: StoredTab, field: TabFormatField): unknown {
  switch (field) {
    case 'conditionalFormats':
      return parseConditionalRules(tab.conditionalFormats ?? undefined) ?? null;
    case 'regions':
      return parseRegions(tab.regions ?? undefined) ?? null;
    case 'frozenRows':
    case 'frozenColumns':
      // The document path stores a freeze of 0; `setFrozen` normalises 0 to
      // "none". They mean the same thing, so they compare the same, or a
      // request to freeze nothing on such a tab would count as a change.
      return tab[field] || null;
    default:
      return tab[field] ?? null;
  }
}

const TAB_FIELD_LOG_OP: Record<TabFormatField, 'format' | 'resize' | 'tab'> = {
  columnFormats: 'format',
  conditionalFormats: 'format',
  columnWidths: 'resize',
  rowHeights: 'resize',
  rowCount: 'resize',
  columnCount: 'resize',
  frozenRows: 'tab',
  frozenColumns: 'tab',
  regions: 'tab',
};

/**
 * `patch` merged over `existing`, as `setCellFormats` does it: a field set to
 * `undefined` clears that field, and a format left with nothing in it is no
 * format at all.
 */
function mergeCellFormat(existing: CellFormat | undefined, patch: CellFormat): CellFormat | undefined {
  const merged: CellFormat = { ...(existing ?? {}), ...patch };
  for (const key of Object.keys(merged) as Array<keyof CellFormat>) {
    if (merged[key] === undefined) delete merged[key];
  }
  return isEmptyFormat(merged) ? undefined : merged;
}

/** Structural equality with key order ignored; `undefined` and `null` agree. */
function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a ?? null) === stableJson(b ?? null);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return inner;
    const record = inner as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = record[key];
        return sorted;
      }, {});
  });
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
      // `max(rowIndex) + 1`, not the declared extent — a caller that plans its
      // next write from this would otherwise land hundreds of rows past the
      // data on any tab whose extent exceeds its populated rows.
      const [{ maxIndex } = { maxIndex: null }] = await tx
        .select({ maxIndex: sql<number | null>`max(${sheetRows.rowIndex})` })
        .from(sheetRows)
        .where(eq(sheetRows.tabId, tab.id));
      return { firstRowIndex: (maxIndex ?? -1) + 1, appended: 0, rowCount: tab.rowCount };
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

    // An entry with no cells writes no row, so counting it would report an
    // append that did not happen and leave a gap where the caller expects data.
    const writable = rows.filter((cells) => Object.keys(cells).length > 0);
    if (writable.length === 0) {
      return { firstRowIndex, appended: 0, rowCount: tab.rowCount };
    }

    const updates: NormalizedUpdate[] = [];
    writable.forEach((cells, offset) => {
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
    const rowCount = Math.max(current?.rowCount ?? tab.rowCount, firstRowIndex + writable.length);
    await updateExtent(
      tab.id,
      { rowCount, columnCount: current?.columnCount ?? tab.columnCount },
      tx
    );
    // No `touchPage` here: the `setCells` above already bumped the revision,
    // and calling it twice advanced `pages.revision` by two per append,
    // burning a value nothing ever holds. The empty-append case returns before
    // reaching `setCells`, and correctly does not bump at all.

    await appendChanges(
      ref.pageId,
      tab.id,
      actor,
      [{ op: 'insert_rows', address: null, rowIndex: firstRowIndex, before: null, after: { appended: writable.length } }],
      tx
    );

    return { firstRowIndex, appended: writable.length, rowCount };
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

    // Validated before anything shifts. A negative `fromRow` would make the
    // scratch-range arithmetic below move rows to indexes the non-negative
    // CHECK rejects, failing the statement halfway through a structural change.
    if (!Number.isInteger(fromRow) || fromRow < 0) {
      throw new Error(`Invalid fromRow: ${fromRow}`);
    }
    if (!Number.isInteger(count)) {
      throw new Error(`Invalid count: ${count}`);
    }
    if (count <= 0) return { deleted: 0, rowCount: tab.rowCount };

    const end = fromRow + count - 1;

    // Serialise on the tab, as `appendRows` and the grow path in `setCells` do.
    //
    // Without it a concurrent append can commit between the `max(rowIndex)`
    // read and the second pass of the shift, so rows that were never parked by
    // pass 1 get moved by `scratch + count` anyway — landing on colliding
    // indexes, or negative ones that violate the non-negative CHECK, part-way
    // through a structural change.
    await tx.select({ id: sheetTabs.id }).from(sheetTabs).where(eq(sheetTabs.id, tab.id)).for('update');

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

    // Re-read under the lock: a `setCells` that grew `columnCount` may have
    // committed while this transaction waited for the tab, and writing back the
    // pre-lock snapshot would stamp the narrower value over it — leaving cells
    // in columns the declared extent no longer covers.
    const locked = await getTab(ref, tx);
    const rowCount = Math.max(0, (locked?.rowCount ?? tab.rowCount) - effectiveCount);
    await updateExtent(
      tab.id,
      { rowCount, columnCount: locked?.columnCount ?? tab.columnCount },
      tx
    );
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
      throw new SheetAddressError(`Invalid cell address: ${update.address}`);
    }
    // `A0` decodes to row -1 and passes every address regex, so without the
    // lower bound it reached `persistRows` and tripped the non-negative CHECK —
    // an opaque 500 where the caller deserved a 400.
    if (position.row < 0 || position.column < 0) {
      throw new SheetAddressError(`Cell address out of range: ${update.address} (rows start at 1)`);
    }
    if (position.row > MAX_ADDRESSABLE_ROW || position.column > MAX_ADDRESSABLE_COLUMN) {
      throw new SheetAddressError(
        `Cell address out of range: ${update.address} (max row ${MAX_ADDRESSABLE_ROW + 1}, max column ZZZ)`
      );
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
  // Ascending, always.
  //
  // `FOR UPDATE` takes row locks in the order rows are returned. Two callers
  // touching an overlapping set in different orders can each hold a lock the
  // other wants and deadlock; a single deterministic order makes that
  // impossible. Sorting also makes the chunk boundaries stable.
  const ordered = [...indexes].sort((a, b) => a - b);

  const CHUNK = 5_000;
  for (let index = 0; index < ordered.length; index += CHUNK) {
    const slice = ordered.slice(index, index + CHUNK);
    let query = exec
      .select({ rowIndex: sheetRows.rowIndex, cells: sheetRows.cells })
      .from(sheetRows)
      .where(and(eq(sheetRows.tabId, tabId), inArray(sheetRows.rowIndex, slice)))
      .orderBy(asc(sheetRows.rowIndex))
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

    // Cumulative across chunks, not per chunk. `target` accumulates, so a
    // formula fanning out over many disjoint spans could load far past the
    // ceiling without any single chunk tripping it — the memory blow-up the cap
    // exists to prevent.
    if (target.size + rows.length > MAX_INPUT_ROWS) {
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
 * Take row locks over `indexes` in ascending order, and nothing else.
 *
 * Separate from loading so the lock set is the whole union a call will write,
 * not just the part it still needs to read. Lock ordering only prevents
 * deadlock if every participant acquires the same set in the same order.
 */
async function lockRows(tabId: string, indexes: number[], exec: Executor): Promise<void> {
  if (indexes.length === 0) return;
  const ordered = [...indexes].sort((a, b) => a - b);

  const CHUNK = 5_000;
  for (let index = 0; index < ordered.length; index += CHUNK) {
    const slice = ordered.slice(index, index + CHUNK);
    await exec
      .select({ rowIndex: sheetRows.rowIndex })
      .from(sheetRows)
      .where(and(eq(sheetRows.tabId, tabId), inArray(sheetRows.rowIndex, slice)))
      .orderBy(asc(sheetRows.rowIndex))
      .for('update');
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

  // Chunked, like every other multi-value statement here. `appendRows` routes
  // each appended cell through `setCells`, so a bulk import puts tens of
  // thousands of addresses in these `IN` lists and would overrun the 65535
  // bind-parameter ceiling as protocol error 08P01.
  for (let index = 0; index < addresses.length; index += INSERT_CHUNK_ROWS) {
    const slice = addresses.slice(index, index + INSERT_CHUNK_ROWS);
    await exec
      .delete(sheetCellDeps)
      .where(and(eq(sheetCellDeps.tabId, tabId), inArray(sheetCellDeps.address, slice)));
    await exec
      .delete(sheetRangeDeps)
      .where(and(eq(sheetRangeDeps.tabId, tabId), inArray(sheetRangeDeps.formulaAddress, slice)));
  }

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
    // The frontier is chunked for the same bind-parameter reason: a bulk write
    // makes it as large as the batch, and both of these statements scale their
    // parameter count with it (the range query at four per address).
    const FRONTIER_CHUNK = 500;
    const found: { address: string }[] = [];

    for (let index = 0; index < frontier.length; index += FRONTIER_CHUNK) {
      const slice = frontier.slice(index, index + FRONTIER_CHUNK);

      found.push(
        ...(await exec
          .select({ address: sheetCellDeps.address })
          .from(sheetCellDeps)
          .where(
            and(
              eq(sheetCellDeps.tabId, tabId),
              sql`${sheetCellDeps.dependsOn} && ${toTextArray(slice)}`
            )
          )
          .limit(MAX_RECOMPUTE_CLOSURE + 1))
      );

      const positions = slice.map((address) => decodeCellAddress(address));
      if (positions.length > 0) {
        found.push(
          ...(await exec
            .select({ address: sheetRangeDeps.formulaAddress })
            .from(sheetRangeDeps)
            .where(and(eq(sheetRangeDeps.tabId, tabId), rangeCovers(positions)))
            .limit(MAX_RECOMPUTE_CLOSURE + 1))
        );
      }
    }

    const next: string[] = [];
    for (const { address } of found) {
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
/**
 * How an upsert combines the cells it carries with the cells already stored.
 *
 * `'merge'` is for a CONTENT writer (`setCells`, materialisation): each cell
 * it carries replaces the stored cell's `raw`, `value`, `type` and `error` —
 * the keys a content write owns — and every other key the stored cell has
 * (`format`, `notes`) survives underneath. `'format'` is the mirror image, for
 * `applyFormatOps`: each carried cell contributes only its `format`, over
 * whatever content the stored cell holds by the time the statement runs.
 * `'replace'` writes the row's cells verbatim — required by the repair path,
 * which is the only caller that legitimately needs a cell to DISAPPEAR, and
 * which holds the whole row anyway.
 */
type PersistMode = 'merge' | 'replace' | 'format';

/**
 * One cell as a `'format'`-mode upsert carries it: `raw` for the insert path
 * only, and `format: null` as the wire form of a clear. Not a `StoredCell` —
 * that type has no null format, and this shape never survives the statement
 * that carries it (see `CELL_MERGE_SQL`).
 */
interface FormatPatchCell {
  raw: string;
  format: CellFormat | null;
}

interface FormatPatchRow {
  rowIndex: number;
  cells: Record<string, FormatPatchCell>;
}

/**
 * The SET expression for `cells` in each mode, evaluated per stored row
 * against `excluded` — the row this statement tried to insert.
 *
 * `excluded.cells` alone loses concurrent writes: two callers each set a
 * different column of the same row, both read the row, both write back their
 * own merged copy, and the second commit erases the first cell — with a
 * success returned to both. A jsonb `||` of the two is a merge keyed by column
 * letter, so each write contributes only the columns it touched.
 *
 * A column-level merge is not enough on its own, though, because a row that
 * does not exist yet cannot be locked. A value write and a format write to the
 * SAME empty cell can therefore both read nothing and both upsert, and with
 * `||` the cell object under that column is replaced whole: whichever commits
 * second wins, and it either drops the format or overwrites the just-entered
 * value with `raw: ''`. So the merge goes one level deeper — per cell, keyed by
 * what each kind of writer OWNS — and the two commits compose in either order.
 *
 * What this does NOT do is arbitrate two writers of the same KIND on the same
 * empty cell: two format writes there are last-writer-wins on `format`, as two
 * value writes are on `raw` — the same-key semantics every writer already has.
 *
 * `jsonb_each` over `excluded.cells` visits exactly the columns the caller
 * carried, so a merge cannot resurrect a cell legitimately removed within the
 * same call. `jsonb_object_agg` of no rows is NULL, hence the coalesce. A
 * stored cell that is somehow not an object (`storedObject`) is treated as
 * absent rather than raising "cannot delete from scalar" on every later write
 * to its row until a rebuild — the old column-level merge replaced it, and a
 * write to a damaged row should stay possible.
 */

/** `stored -> key` when it is an object, else `fallback`. */
const storedObject = (key: ReturnType<typeof sql>, fallback: string) =>
  sql`coalesce(CASE WHEN jsonb_typeof(${sheetRows.cells} -> ${key}) = 'object' THEN ${sheetRows.cells} -> ${key} END, ${sql.raw(fallback)}::jsonb)`;

const CELL_MERGE_SQL: Record<PersistMode, ReturnType<typeof sql>> = {
  replace: sql`excluded."cells"`,
  merge: sql`${sheetRows.cells} || (
    SELECT coalesce(jsonb_object_agg(
      patch.key,
      (${storedObject(sql`patch.key`, "'{}'")} - '{raw,value,type,error}'::text[]) || patch.value
    ), '{}'::jsonb)
    FROM jsonb_each(excluded."cells") AS patch
  )`,
  // A format cell arrives as `{ raw, format }` — `raw` so a brand-new row
  // inserts a well-formed `StoredCell`, and dropped here because the stored
  // cell's own content is the truth once one exists. `format: null` is how a
  // clear travels (jsonb `||` cannot delete a key); `jsonb_strip_nulls` turns
  // it into the deletion it means, and touches nothing else because no
  // `StoredCell` field is ever legitimately null.
  format: sql`${sheetRows.cells} || (
    SELECT coalesce(jsonb_object_agg(
      patch.key,
      jsonb_strip_nulls(${storedObject(sql`patch.key`, `'{"raw": ""}'`)} || (patch.value - 'raw'))
    ), '{}'::jsonb)
    FROM jsonb_each(excluded."cells") AS patch
  )`,
};

async function persistRows(
  tabId: string,
  pageId: string,
  rows: Map<number, StoredRow>,
  exec: Executor,
  mode?: 'merge' | 'replace'
): Promise<void>;
async function persistRows(
  tabId: string,
  pageId: string,
  rows: Map<number, FormatPatchRow>,
  exec: Executor,
  mode: 'format'
): Promise<void>;
async function persistRows(
  tabId: string,
  pageId: string,
  rows: Map<number, StoredRow | FormatPatchRow>,
  exec: Executor,
  mode: PersistMode = 'merge'
): Promise<void> {
  // Ascending by row, for the same reason `lockRows` is: rows that do not
  // exist yet cannot be locked ahead of time, so a multi-row insert takes its
  // speculative locks in statement order, and two writers creating the same
  // new rows in opposite orders would deadlock mid-statement.
  const values = Array.from(rows.values())
    .sort((a, b) => a.rowIndex - b.rowIndex)
    .map((row) => ({
      tabId,
      pageId,
      rowIndex: row.rowIndex,
      // A format patch is a wire shape the column type does not describe; the
      // overloads above pin which shape each mode accepts, and the `'format'`
      // expression consumes it before anything of that shape is stored.
      cells: row.cells as Record<string, StoredCell>,
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
          cells: CELL_MERGE_SQL[mode],
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
    .set({
      revision: sql`${pages.revision} + 1`,
      // `stateHash` moves too. Restore-diff decides a page is unchanged by
      // comparing a backup version's `stateHash` against the page's, so leaving
      // it at whatever the last DOCUMENT write computed meant a sheet that had
      // taken five hundred form submissions since the backup was reported as
      // unmodified and skipped.
      //
      // Marked rather than recomputed: deriving the real content hash would
      // mean projecting the whole sheet on every cell write, which is the
      // O(document) cost this path exists to avoid. A distinct value per write
      // is all the "has this changed" comparison needs.
      stateHash: sql`md5(${pages.id} || '/' || (${pages.revision} + 1)::text)`,
      updatedAt: new Date(),
    })
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
    conditionalFormats: row.conditionalFormats,
    regions: row.regions,
  };
}

function clampPageSize(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_ROW_PAGE_SIZE;
  return Math.min(limit, MAX_ROW_PAGE_SIZE);
}

function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}
