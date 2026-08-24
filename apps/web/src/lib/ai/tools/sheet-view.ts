/**
 * The agent-facing view of a sheet: a bounded window of rows, in the shape a
 * model can actually read.
 *
 * Sheets were re-architected onto a row store, and `/api/mcp/sheets` exposes
 * that store as `query-rows`/`get-rows`/`describe` for SDK and CLI callers. The
 * in-process AI tools had no equivalent, so every agent read of a sheet went
 * through `readSheetDocument` — the whole spreadsheet reconstructed as a
 * SheetDoc TOML document, then flattened to numbered lines. A 500x16 sheet came
 * back as ~24,000 lines of `[sheets.cells.AB417]` tables. Agents responded the
 * only way they could: by keeping a readable copy of the data outside the
 * platform (issue #2467).
 *
 * This module is the shared window everything agent-facing reads through, so
 * `read_page`, `list_pages include: "content"` and `read_sheet` cannot drift on
 * what a sheet looks like.
 *
 * It is deliberately NOT a query engine. Filtering, projection and ordering all
 * belong to `queryRows` in `@pagespace/lib/sheets/store`, which compiles them to
 * SQL against the materialised cell value; `read_sheet` passes its arguments
 * through and formats what comes back.
 */
import type { StoredCell } from '@pagespace/db/schema/sheets-types';
import { getTab, listTabs, readRows } from '@pagespace/lib/sheets/store';
import {
  SHEETDOC_VERSION,
  decodeCellAddress,
  encodeColumnLabel,
  evaluateSheetSparse,
  parseSheetContentSafe,
  sheetDataFromSheetDoc,
  type SheetData,
} from '@pagespace/lib/sheets/sheet';

/**
 * Rows shown by `read_page` when no range is asked for.
 *
 * A preview, not a read: enough to see the header row and the shape of the
 * data, then the response points at `read_sheet` for the rest. Deliberately
 * small — `read_page` is the tool an agent calls on a page it knows nothing
 * about, and it must stay cheap on a page that turns out to hold 500 rows.
 */
export const SHEET_PREVIEW_ROWS = 25;

/**
 * Rows shown per sheet by `list_pages include: "content"`, which previews many
 * pages in one response and so can afford far less per page than `read_page`.
 */
export const SHEET_LIST_PREVIEW_ROWS = 5;

/**
 * The most rows `read_sheet` will return in one call.
 *
 * The store's own cap (`MAX_ROW_PAGE_SIZE`, 5,000) bounds a fetch; this bounds
 * what lands in a model's context, which is a much smaller budget — 5,000 rows
 * of a 16-column sheet is on the order of a megabyte of JSON. Paging with
 * `fromRow`/`offset` is the intended way to read more.
 */
export const MAX_SHEET_READ_ROWS = 500;

/** Default rows per `read_sheet` call when the caller names no limit. */
export const DEFAULT_SHEET_READ_ROWS = 50;

/**
 * A cell value is truncated at this many characters in the rendered TABLE only.
 * The structured `rows` a tool returns always carry the full text — the table
 * is a human/model-legible rendering, not the data.
 */
const MAX_TABLE_CELL_CHARS = 120;

/**
 * A stored sheet document that could not be parsed.
 *
 * Thrown rather than degraded into an empty sheet. `parseSheetContentSafe`
 * distinguishes "genuinely empty" from "failed to read" precisely so callers
 * stop conflating them, and the materialisation path in the store already fails
 * loudly here for the same reason: telling an agent that a spreadsheet it
 * cannot parse is BLANK invites it to write over content that is still intact.
 * A crippled read that reports success is worse than a read that refuses.
 */
export class SheetDocumentUnreadableError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'SheetDocumentUnreadableError';
  }
}

/**
 * A tab index that does not exist on this sheet.
 *
 * Also loud, and for the same reason: answering a request for tab 2 with tab
 * 0's rows is a wrong answer an agent has no way to detect. Carries the tabs
 * that DO exist so the next call can be right.
 */
export class SheetTabNotFoundError extends Error {
  constructor(
    readonly tabIndex: number,
    readonly availableTabs: readonly SheetTabSummary[],
  ) {
    super(
      `Sheet tab ${tabIndex} does not exist. This sheet has ${availableTabs.length} tab(s): ` +
      availableTabs.map((tab) => `${tab.tabIndex} ("${tab.name}")`).join(', ') + '.'
    );
    this.name = 'SheetTabNotFoundError';
  }
}

export interface SheetTabSummary {
  tabIndex: number;
  name: string;
  rowCount: number;
  columnCount: number;
}

/** One row of a sheet, projected for a model. */
export interface SheetViewRow {
  /** 1-based, matching A1 addressing — row 1 is `A1`'s row. */
  rowNumber: number;
  /** Column letter → the cell's materialised value as text. */
  cells: Record<string, string>;
  /**
   * Column letter → the authored formula, present only for cells that have
   * one. Kept separate from `cells` so a read never loses the distinction
   * between "5" and "=2+3", which is the whole reason a sheet is not a table.
   */
  formulas?: Record<string, string>;
  /** Column letter → evaluation error message, present only for errored cells. */
  errors?: Record<string, string>;
}

export interface SheetWindow {
  /**
   * False when the sheet's rows still live in `pages.content` and have not been
   * migrated to the row store. The window is then parsed and evaluated from the
   * document instead — correct, but O(sheet), and `read_sheet`'s filtering is
   * unavailable because there is nothing to filter in SQL.
   */
  materialized: boolean;
  tabIndex: number;
  tabName: string;
  rowCount: number;
  columnCount: number;
  tabs: SheetTabSummary[];
  rows: SheetViewRow[];
  /**
   * The 0-based row index to continue from, or null when this window reached
   * the end. A POSITION rather than a running count, because a sheet's rows are
   * sparse — rows 0-9 then 500-509 is a normal shape, and an agent advancing by
   * `rows.length` would loop forever on the same window.
   */
  nextFromRow: number | null;
  hasMore: boolean;
}

/**
 * Sheet column order: shorter labels first, then alphabetical — so "Z" sorts
 * before "AA". Plain string comparison gets this wrong, which would silently
 * reorder the columns of any sheet wider than 26.
 */
function compareColumnLabels(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every column letter appearing in a window, in sheet order. */
export function columnsInRows(rows: readonly SheetViewRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const label of Object.keys(row.cells)) seen.add(label);
  }
  return [...seen].sort(compareColumnLabels);
}

/** A stored cell's display text: the computed value, falling back to what was authored. */
function cellText(cell: StoredCell): string {
  if (cell.error) return '#ERROR';
  if (cell.value !== undefined && cell.value !== '') return String(cell.value);
  // A formula whose value never materialised would otherwise render as its own
  // source text, which reads like data. Show it as a formula instead.
  return cell.raw ?? '';
}

/**
 * One stored row projected for a model.
 *
 * Exported so `read_sheet`s filtered path can project the rows `queryRows`
 * returns through exactly the same shaping as a positional window — two
 * renderings of the same row would be a bug an agent could only discover by
 * comparing two calls.
 */
export function toSheetViewRow(
  rowIndex: number,
  cells: Record<string, StoredCell>,
  /**
   * Column letters to keep. Omitted means every column the row has. Applied
   * here rather than at a call site so a projected row is projected in ALL of
   * `cells`, `formulas` and `errors` — dropping a column from the rendered
   * table while leaving it in the structured payload is not a projection, it is
   * a bigger response that merely looks smaller.
   */
  only?: ReadonlySet<string>,
): SheetViewRow {
  const values: Record<string, string> = {};
  const formulas: Record<string, string> = {};
  const errors: Record<string, string> = {};

  for (const label of Object.keys(cells).sort(compareColumnLabels)) {
    if (only && !only.has(label)) continue;
    const cell = cells[label];
    if (!cell) continue;
    const text = cellText(cell);
    // An empty cell is absent, not blank: a 500x16 sheet is mostly empty, and
    // emitting every empty cell would put the payload straight back where it was.
    if (text === '' && !cell.error && !(cell.raw ?? '').startsWith('=')) continue;
    values[label] = text;
    if ((cell.raw ?? '').startsWith('=')) formulas[label] = cell.raw;
    if (cell.error) errors[label] = cell.error.message ?? cell.error.type;
  }

  const row: SheetViewRow = { rowNumber: rowIndex + 1, cells: values };
  if (Object.keys(formulas).length > 0) row.formulas = formulas;
  if (Object.keys(errors).length > 0) row.errors = errors;
  return row;
}

/**
 * Stored tab rows narrowed to what a caller is told about a tab.
 *
 * Shared so the window and `read_sheet`'s filtered path cannot describe the
 * same tabs differently.
 */
export function toTabSummaries(
  tabs: readonly { tabIndex: number; name: string; rowCount: number; columnCount: number }[]
): SheetTabSummary[] {
  return tabs.map((tab) => ({
    tabIndex: tab.tabIndex,
    name: tab.name,
    rowCount: tab.rowCount,
    columnCount: tab.columnCount,
  }));
}

/**
 * Every tab a stored document describes.
 *
 * `parseSheetContentSafe` returns the FIRST tab as the `SheetData` and the rest
 * in `extraSheets`, already sorted by their `order` field (`sortSheetDoc` runs
 * on the way in). Position in this list is therefore the tab index, which is
 * the same correspondence `readSheetDocument` relies on in the other
 * direction when it writes `order: tab.tabIndex`.
 */
function documentTabs(sheet: SheetData): SheetTabSummary[] {
  return [
    {
      tabIndex: 0,
      name: sheet.sheetName ?? 'Sheet1',
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
    },
    ...(sheet.extraSheets ?? []).map((extra, index) => ({
      tabIndex: index + 1,
      name: extra.name,
      rowCount: Math.max(1, Math.floor(extra.meta.rowCount)),
      columnCount: Math.max(1, Math.floor(extra.meta.columnCount)),
    })),
  ];
}

/**
 * A window of a sheet whose rows have not been materialised.
 *
 * Legacy path: parse the stored document and evaluate it sparsely, which is
 * exactly what serialising it for the old read path already did — so this is no
 * more expensive than the behaviour it replaces, and it stays a pure READ.
 * Materialising here instead would be a write, triggered by a reader who may
 * only have view access.
 *
 * Throws rather than degrading on either thing it cannot honour: a document it
 * cannot parse, and a tab that does not exist. Both would otherwise be answered
 * with rows — an empty sheet, or another tab's data — that an agent has no way
 * to tell apart from the truth.
 */
function windowFromDocument(
  content: unknown,
  pageId: string,
  tabIndex: number,
  fromRow: number,
  limit: number,
  only?: ReadonlySet<string>,
): SheetWindow {
  const parsed = parseSheetContentSafe(content);
  if (!parsed.ok) {
    throw new SheetDocumentUnreadableError(
      parsed.reason,
      `This sheet's stored document could not be parsed (${parsed.reason}): ${parsed.message}. ` +
      'The document needs repair before the sheet can be read; it is not empty.'
    );
  }

  const tabs = documentTabs(parsed.sheet);
  const summary = tabs[tabIndex];
  if (!summary) {
    throw new SheetTabNotFoundError(tabIndex, tabs);
  }

  // Tab 0 IS the parsed `SheetData`. A later tab is one `SheetDocSheet`, turned
  // into `SheetData` by the same conversion that produced tab 0 — reusing it
  // rather than reimplementing the cell/format/range unpacking here.
  const extra = tabIndex === 0 ? undefined : (parsed.sheet.extraSheets ?? [])[tabIndex - 1];
  const sheet: SheetData = extra
    ? sheetDataFromSheetDoc({ version: SHEETDOC_VERSION, pageId, sheets: [extra] })
    : parsed.sheet;

  const evaluation = evaluateSheetSparse(sheet, { pageId });

  const byRow = new Map<number, Record<string, StoredCell>>();
  for (const [address, raw] of Object.entries(sheet.cells)) {
    // `decodeCellAddress` throws on anything that is not A1-shaped. A stored
    // document is normally parser-produced and can't contain one, but a
    // hand-edited or externally-imported sheet can — and one junk key must not
    // make the whole page unreadable, which is the failure this tool exists to
    // remove. Skip it and read the rest.
    let decoded: { row: number; column: number };
    try {
      decoded = decodeCellAddress(address);
    } catch {
      continue;
    }
    const label = encodeColumnLabel(decoded.column);
    const evaluated = evaluation.byAddress[address];
    const cell: StoredCell = {
      raw,
      value: evaluated?.display ?? raw,
      ...(evaluated?.error ? { error: { type: 'error', message: evaluated.error } } : {}),
    };
    const existing = byRow.get(decoded.row);
    if (existing) existing[label] = cell;
    else byRow.set(decoded.row, { [label]: cell });
  }

  const indexes = [...byRow.keys()].filter((index) => index >= fromRow).sort((a, b) => a - b);
  const windowed = indexes.slice(0, limit);
  const rows = windowed.map((index) => toSheetViewRow(index, byRow.get(index) ?? {}, only));
  const nextFromRow = windowed.length > 0 ? windowed[windowed.length - 1] + 1 : null;

  return {
    materialized: false,
    tabIndex,
    tabName: summary.name,
    rowCount: summary.rowCount,
    columnCount: summary.columnCount,
    tabs,
    rows,
    nextFromRow,
    hasMore: nextFromRow !== null && indexes.length > windowed.length,
  };
}

interface LoadSheetWindowOptions {
  tabIndex?: number;
  /** 0-based row index to start at. */
  fromRow?: number;
  limit: number;
  /**
   * Column letters to return. Omitted means every column each row has.
   *
   * Applied here, not at a call site, so a positional read projects exactly
   * like a filtered one — `queryRows` does its own projection in the store, and
   * a range read that only narrowed the rendered table would have returned the
   * full payload while reporting the narrow column list.
   */
  select?: readonly string[];
  /**
   * The page's stored `content`, used only when the sheet has no rows in the
   * store yet. Pass it so an unmigrated sheet reads as its data rather than as
   * an empty spreadsheet.
   */
  documentContent?: unknown;
}

/**
 * A positional window of rows, from the row store when the sheet has been
 * materialised and from the stored document when it has not.
 *
 * Throws `SheetDocumentUnreadableError` or `SheetTabNotFoundError` rather than
 * answering with rows it was not asked for. Callers translate those into an
 * actionable tool result; none of them may treat either as "the sheet is
 * empty".
 */
export async function loadSheetWindow(
  pageId: string,
  options: LoadSheetWindowOptions
): Promise<SheetWindow> {
  const tabIndex = options.tabIndex ?? 0;
  const fromRow = Math.max(0, options.fromRow ?? 0);
  const limit = Math.max(1, Math.min(options.limit, MAX_SHEET_READ_ROWS));
  const only = options.select && options.select.length > 0
    ? new Set(options.select.map((column) => column.toUpperCase()))
    : undefined;

  const storedTabs = await listTabs(pageId);
  if (storedTabs.length === 0) {
    return windowFromDocument(options.documentContent, pageId, tabIndex, fromRow, limit, only);
  }

  const tabs = toTabSummaries(storedTabs);

  const tab = await getTab({ pageId, tabIndex });
  if (!tab) {
    // Same refusal as the document path. Reporting "0 rows x 0 columns" for a
    // tab index that simply does not exist reads as an empty spreadsheet, and
    // an agent would believe it.
    throw new SheetTabNotFoundError(tabIndex, tabs);
  }

  const stored = await readRows(tab.id, { fromRow, limit });
  const rows = stored.map((row) => toSheetViewRow(row.rowIndex, row.cells, only));
  const nextFromRow = stored.length > 0 ? stored[stored.length - 1].rowIndex + 1 : null;

  return {
    materialized: true,
    tabIndex,
    tabName: tab.name,
    rowCount: tab.rowCount,
    columnCount: tab.columnCount,
    tabs,
    rows,
    nextFromRow,
    hasMore: nextFromRow !== null && nextFromRow < tab.rowCount,
  };
}

/**
 * A window of rows as delimited text, one line per sheet row.
 *
 * Keeps `read_page`'s `N→` line convention so the surface still reads the same
 * way, except that N is the SHEET ROW NUMBER rather than a line of serialised
 * TOML — which is what makes it addressable: the number in front of a row is
 * the number in that row's A1 addresses, so an agent can go straight from
 * reading row 417 to writing `C417`.
 *
 * Newlines inside a cell are escaped rather than emitted, or one cell would
 * silently become several rows.
 *
 * Returns the count of cells it had to cut as well as the text. The table is a
 * RENDERING — the structured rows beside it always carry the full value — but a
 * reader working from the table alone would have no way to know a value was
 * shortened beyond the ellipsis, and could copy a truncated string back into a
 * write. Callers surface the count so that is stated rather than inferred.
 */
export function renderSheetTable(
  rows: readonly SheetViewRow[],
  columns?: readonly string[]
): { text: string; truncatedCells: number } {
  const labels = columns ? [...columns].sort(compareColumnLabels) : columnsInRows(rows);
  if (labels.length === 0) return { text: '', truncatedCells: 0 };

  let truncatedCells = 0;
  const lines = [`columns→${labels.join(' | ')}`];
  for (const row of rows) {
    const cells = labels.map((label) => {
      const value = row.cells[label] ?? '';
      const flat = value.replace(/\r?\n/g, '\\n');
      if (flat.length <= MAX_TABLE_CELL_CHARS) return flat;
      truncatedCells++;
      return `${flat.slice(0, MAX_TABLE_CELL_CHARS)}…`;
    });
    lines.push(`${row.rowNumber}→${cells.join(' | ')}`);
  }
  return { text: lines.join('\n'), truncatedCells };
}

/** The character budget one cell gets in a rendered table. */
export const TABLE_CELL_CHAR_LIMIT = MAX_TABLE_CELL_CHARS;
