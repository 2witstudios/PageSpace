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
import type { CellFormat, StoredCell, StoredCellValue } from '@pagespace/db/schema/sheets-types';
import { getTab, listTabs, readRows } from '@pagespace/lib/sheets/store';
import {
  SHEETDOC_VERSION,
  applyNumberFormat,
  formatDisplayValue,
  resolveCellFormat,
  isSheetDocString,
  decodeCellAddress,
  decodeColumnLabel,
  encodeColumnLabel,
  evaluateSheetSparse,
  parseSheetContentSafe,
  sheetDataFromSheetDoc,
  createRegionResolver,
  parseConditionalRules,
  parseRegions,
  type SheetData,
  type ConditionalCondition,
  type ConditionalOperator,
  type ConditionalRule,
  type RegionResolver,
  type SheetRegion,
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

/**
 * The region-derived format at one cell, or `undefined` where no region covers
 * it — and also where the column key is not a column label at all.
 *
 * `cells` is jsonb: a hand-edited or externally-imported row can carry a key
 * like `C0` that `decodeColumnLabel` refuses. Letting that throw would make one
 * junk key fail the whole read, which is the failure this module exists to
 * remove and which the document path's address walk already guards against.
 * A cell whose column cannot be located simply gets no region format.
 */
function regionFormatAt(
  presentation: CellPresentation | undefined,
  label: string,
  rowIndex: number,
): CellFormat | undefined {
  if (!presentation?.regionAt) return undefined;
  try {
    return presentation.regionAt(rowIndex, decodeColumnLabel(label));
  } catch {
    return undefined;
  }
}

/**
 * The presentation layers a stored cell is rendered against.
 *
 * Both are cheap and derived from the tab the caller already has: the column
 * defaults are a map lookup, and `regionAt` is the closure
 * `createRegionResolver` prepares once per window so a per-cell resolve is a
 * bounds test and at most three spreads.
 *
 * Conditional formatting is deliberately NOT here. A rule's format depends on
 * the value of cells the window may not hold, and on evaluating its formula
 * against the whole sheet — which a bounded read cannot do without becoming
 * O(sheet). The document path picks it up for free (the evaluator has already
 * run there); the row-store path does not, and that asymmetry predates this
 * change rather than arriving with it.
 */
export interface CellPresentation {
  columnFormats?: Record<string, CellFormat> | null;
  regionAt?: RegionResolver;
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
  /**
   * Column letter → the typed machine value, present only for cells whose
   * display string is not already it.
   *
   * `cells` carries the DISPLAY text, because that is what a person sees and
   * what an agent has to reconcile against. But it is lossy in exactly one
   * direction that matters: a cell displayed as `$1,200.00` cannot be turned
   * back into the `1200` that `where` compares against, or into the number a
   * formula would have to add up. The value was already in hand — `StoredCell`
   * carries both halves — and throwing it away made every formatted read a
   * one-way trip.
   *
   * Emitted only on divergence, so an unformatted sheet pays nothing for it and
   * a formatted one recovers exactly the cells that need recovering. A column
   * letter absent here means `cells[label]` is already the value — with one
   * exception worth stating precisely, because a contract that is *nearly* true
   * is the kind an agent gets caught by: a cell that was never materialised has
   * no machine value at all, and `cells` carries the text it was authored with.
   * That cell appears in `formulas` when it holds one, which is how it is told
   * apart.
   */
  unformatted?: Record<string, StoredCellValue>;
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
  /**
   * True when the page's stored content is not a sheet document at all —
   * legacy plain text or HTML on a SHEET page.
   *
   * `parseSheetContentSafe` reports that as an EMPTY sheet, correctly: it is
   * not a parse failure, because there is no sheet data to lose. Taken at face
   * value it reads as "this spreadsheet is blank", which hides content every
   * surface used to display. Callers use this to fall back to the text instead.
   */
  documentIsNotASheet: boolean;
  /**
   * The tab's presentation, when the caller asked for it — from the stored tab
   * when the sheet has been materialised and from the parsed document when it
   * has not, so an unmigrated sheet is described rather than refused.
   *
   * Absent (rather than empty) when it was not asked for, so a caller cannot
   * read "no formatting was requested" as "this sheet has no formatting".
   */
  formatting?: SheetFormatting;
}

/**
 * Sheet column order: shorter labels first, then alphabetical — so "Z" sorts
 * before "AA". Plain string comparison gets this wrong, which would silently
 * reorder the columns of any sheet wider than 26.
 */
export function compareColumnLabels(a: string, b: string): number {
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

/**
 * A stored cell's display text: the computed value, falling back to what was
 * authored.
 *
 * Formatted the way the evaluator formats, because the two paths must not
 * render one cell two ways. The document path stores `evaluated.display`, which
 * has had BOTH `formatDisplayValue` and the cell's number format applied; the
 * row store keeps the raw materialised primitive with the format alongside it.
 * Doing neither showed `=A1+B1` as `0.3` before migration and
 * `0.30000000000000004` after; doing only the first showed a currency column as
 * `$1,200.00` before and `1200` after. An agent reconciling against what the
 * user sees on screen — or filtering on a value it read pre-migration — gets no
 * matches from that.
 */
function cellText(cell: StoredCell, columnFormat?: CellFormat, regionFormat?: CellFormat): string {
  if (cell.error) return '#ERROR';
  // `undefined` means never materialised; `''` means it materialised AS blank.
  // Conflating them rendered `=IF(A2>0,"ok","")` as its own source text where
  // the spreadsheet shows an empty cell — and `where: isEmpty` matched that
  // same row, because the filter compares the stored `''`. Two reads of one
  // cell disagreeing is the shape this whole change exists to remove.
  if (cell.value !== undefined) {
    // An empty value needs no special case: every numeric format rejects a
    // blank string (`applyNumberFormat` requires `value.trim() !== ''`) and
    // `formatDisplayValue('')` is `''`, so a formatted blank stays blank.
    // Column formats are NOT denormalised onto the cell: `sheetDataToRows`
    // copies only `sheet.formats[address]`, while column formats live on
    // `sheet_tabs.columnFormats`. Resolving just the cell format therefore
    // still diverged for the common case — a column formatted as currency read
    // `$1,200.00` from the document path and the UI, and `1200` from the row
    // store. Same precedence the evaluator uses: cell overrides column.
    // All three layers, in the evaluator's own precedence: column default under
    // region-derived under the cell's own format. Resolving only two of them
    // was the row store's remaining divergence — a column declared `currency`
    // by a REGION renders `$1,200.00` in the grid and read back as `1200` here,
    // so an agent that had just declared the region saw none of it and could
    // not tell its own formatting had applied. Region-derived presentation is
    // the mechanism this epic makes primary, so a read that ignores it is
    // reading a different sheet than the one on screen.
    const format = resolveCellFormat(cell.format, columnFormat, regionFormat);
    const formatted = applyNumberFormat(cell.value, format?.number);
    return formatted !== null ? formatted : formatDisplayValue(cell.value);
  }
  // Only a cell with no materialised value at all falls back to what was
  // authored, so a formula is never silently reported as data.
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
  /**
   * The presentation layers that sit UNDER a cell's own format.
   *
   * One object rather than a parameter each: they are resolved together, in a
   * fixed precedence, and a caller that supplies one and forgets the other
   * renders the cell differently from every other surface — which is the
   * failure this module exists to remove.
   */
  presentation?: CellPresentation,
): SheetViewRow {
  const values: Record<string, string> = {};
  const formulas: Record<string, string> = {};
  const errors: Record<string, string> = {};
  const unformatted: Record<string, StoredCellValue> = {};

  for (const label of Object.keys(cells).sort(compareColumnLabels)) {
    if (only && !only.has(label)) continue;
    const cell = cells[label];
    if (!cell) continue;
    const text = cellText(cell, presentation?.columnFormats?.[label], regionFormatAt(presentation, label, rowIndex));
    // An empty cell is absent, not blank: a 500x16 sheet is mostly empty, and
    // emitting every empty cell would put the payload straight back where it was.
    if (text === '' && !cell.error && !(cell.raw ?? '').startsWith('=')) continue;
    values[label] = text;
    if ((cell.raw ?? '').startsWith('=')) formulas[label] = cell.raw;
    if (cell.error) errors[label] = cell.error.message ?? cell.error.type;
    // Only where the display is not already the value. `String(value)` is the
    // right comparison and not an approximation of one: it is exactly what
    // `formatDisplayValue` produces for the unformatted case, so equality here
    // means the display text already IS the machine value and a second copy of
    // it would be pure payload. An errored cell is excluded because its display
    // is `#ERROR`, not a rendering of the value — reporting a value beside an
    // error invites an agent to use it.
    if (cell.value !== undefined && !cell.error && String(cell.value) !== text) {
      unformatted[label] = cell.value;
    }
  }

  const row: SheetViewRow = { rowNumber: rowIndex + 1, cells: values };
  if (Object.keys(formulas).length > 0) row.formulas = formulas;
  if (Object.keys(errors).length > 0) row.errors = errors;
  if (Object.keys(unformatted).length > 0) row.unformatted = unformatted;
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
 * Legacy path: parse the stored document and evaluate it sparsely. It stays a
 * pure READ — materialising instead would be a write, triggered by a reader who
 * may only have view access.
 *
 * It is NOT free, and an earlier version of this comment wrongly claimed it was
 * no more expensive than what it replaced. That held for migrated sheets; for
 * an UNMIGRATED one the old path called `readSheetDocument`, got `null` after a
 * single empty `listTabs`, and handed back `pages.content` verbatim with no
 * parse at all. This TOML-parses the document and evaluates every non-empty
 * cell — on a 500x16 sheet, a ~460KB parse and ~8,000 evaluations. Per read for
 * `read_page`, per sheet for `list_pages`, and per TURN for a command whose
 * entry page is one. The cost buys the formula results and the not-a-sheet
 * detection every caller now depends on, and it applies only to sheets nobody
 * has edited since the row store shipped — but it is a real cost, and a future
 * reader should size it rather than trust a claim that it is free.
 *
 * Throws rather than degrading on either thing it cannot honour: a document it
 * cannot parse, and a tab that does not exist. Both would otherwise be answered
 * with rows — an empty sheet, or another tab's data — that an agent has no way
 * to tell apart from the truth.
 */
interface DocumentWindowOptions {
  content: unknown;
  pageId: string;
  tabIndex: number;
  /** 0-based row index to start at. */
  fromRow: number;
  limit: number;
  /** Column letters to keep; omitted means every column each row has. */
  only?: ReadonlySet<string>;
  includeFormatting?: boolean;
}

function windowFromDocument({
  content,
  pageId,
  tabIndex,
  fromRow,
  limit,
  only,
  includeFormatting,
}: DocumentWindowOptions): SheetWindow {
  const parsed = parseSheetContentSafe(content);
  if (!parsed.ok) {
    throw new SheetDocumentUnreadableError(
      parsed.reason,
      `This sheet's stored document could not be parsed (${parsed.reason}): ${parsed.message}. ` +
      'The document needs repair before the sheet can be read; it is not empty.'
    );
  }

  // "Never was a sheet" is narrower than "parsed to no cells". A pre-SheetDoc
  // sheet stored as JSON — `{"cells":{},"rowCount":20,...}` — parses to a
  // perfectly valid EMPTY sheet, and calling that text told the agent not to
  // write to a sheet that is genuinely empty and safe to write. Only content
  // that is neither a SheetDoc nor JSON took `parseSheetContentSafe`'s
  // arbitrary-text fallback, and only that is really text.
  const trimmed = typeof content === 'string' ? content.trim() : '';
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  const isText =
    trimmed.length > 0 &&
    !isSheetDocString(trimmed) &&
    !looksLikeJson &&
    Object.keys(parsed.sheet.cells).length === 0;

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
    // The MACHINE value, with the format that produced its display beside it —
    // not the display string.
    //
    // Storing `evaluated.display` here made the display correct and the value a
    // copy of it, so a legacy sheet's `$1,200.00` had no `1200` anywhere in the
    // response and an agent reading a range from an unmigrated sheet (a read
    // this tool explicitly supports) got the same one-way payload `unformatted`
    // exists to remove. `SheetEvaluationCell` carries both halves and the
    // `format` it actually applied — with the column default and any region
    // already resolved into it, which is why no `columnFormats` are passed
    // below — so `cellText` re-derives exactly the display the evaluator
    // produced from the value the agent needs.
    const cell: StoredCell = {
      raw,
      value: evaluated ? evaluated.value : raw,
      ...(evaluated?.type ? { type: evaluated.type } : {}),
      ...(evaluated?.format ? { format: evaluated.format } : {}),
      ...(evaluated?.error ? { error: { type: 'error', message: evaluated.error } } : {}),
    };
    const existing = byRow.get(decoded.row);
    if (existing) existing[label] = cell;
    else byRow.set(decoded.row, { [label]: cell });
  }

  const indexes = [...byRow.keys()].filter((index) => index >= fromRow).sort((a, b) => a - b);
  const windowed = indexes.slice(0, limit);
  // No column formats here, deliberately. The synthetic cell above already
  // carries `evaluated.format`, which the evaluator resolved cell-over-column
  // (and over any region) before it formatted the display. Passing the column
  // formats again would be at best redundant and at worst let a column default
  // beat a per-cell override: a `plain` cell inside a currency column rendered
  // `$1,200.00` here while the UI and the row store both showed `1200`.
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
    documentIsNotASheet: isText,
    // Read from the document, not refused.
    //
    // An unmigrated sheet has no `sheet_tabs` row, and the first version of this
    // answered `formatting: null` on the grounds that there was nowhere to read
    // it from. That was wrong on the facts: `parseSheetContentSafe` reconstructs
    // the regions, freezes, widths, heights, column formats, per-cell formats
    // and conditional rules from `pages.content`, and this function has already
    // parsed and selected that tab. Withholding them would have hidden the
    // existing design at exactly the moment an agent needs it — before its first
    // formatting change to a sheet nobody has edited since the row store
    // shipped.
    //
    // `sheet.formats` and NOT the synthetic cells' `format`: the cells carry the
    // RESOLVED format (column and region folded in), while `cellFormats` means
    // the explicit per-cell overrides. Reporting a derived fill as an override
    // is how a region model decays back into per-cell residue.
    ...(includeFormatting
      ? {
          formatting: buildSheetFormatting(
            sheet,
            documentCellFormats(sheet.formats, windowed, only),
          ),
        }
      : {}),
  };
}

/**
 * The explicit per-cell formats a parsed document holds, for the rows in the
 * window.
 *
 * Restricted to the window for the same reason the row-store path only sees the
 * rows it fetched: `cellFormats` describes the rows that were returned, and a
 * document's `formats` map covers the whole sheet. Sorted by row then column so
 * the budget always drops the same cells for the same window.
 */
function documentCellFormats(
  formats: Record<string, CellFormat> | undefined,
  rowIndexes: readonly number[],
  only: ReadonlySet<string> | undefined,
): [string, CellFormat][] {
  if (!formats) return [];

  // The window's SPAN, and only the span.
  //
  // A format-only row is a real shape and a legacy sheet's most likely one: a
  // blank input row someone pre-styled. `windowed` is built from `sheet.cells`,
  // so such a row is not in it — while `rowsFromSheetData` materialises the
  // UNION of cells and formats, which means the same read reports that styling
  // after migration and dropped it before. Silently losing formatting across a
  // migration is exactly the drift this module exists to remove.
  //
  // A styled row between the first and last row returned is inside what the
  // reader is looking at; one a thousand rows further down is not, and letting
  // those in would spend the budget on rows the agent cannot see. Testing
  // membership as well would be dead weight — every row in the window is inside
  // its own span by definition. An empty window spans nothing and admits
  // nothing, which is what the inverted default encodes.
  //
  // Min and max rather than first and last: the one caller passes a sorted
  // window, but a span that silently inverts if it ever stopped being sorted is
  // a worse failure than one extra pass over at most `limit` numbers.
  let spanStart = Infinity;
  let spanEnd = -Infinity;
  for (const index of rowIndexes) {
    if (index < spanStart) spanStart = index;
    if (index > spanEnd) spanEnd = index;
  }
  const entries: { row: number; label: string; address: string; format: CellFormat }[] = [];

  for (const [address, format] of Object.entries(formats)) {
    if (!format || Object.keys(format).length === 0) continue;
    // Same tolerance as the cell walk above: one junk key in a hand-edited
    // document must not make the formatting unreadable.
    let decoded: { row: number; column: number };
    try {
      decoded = decodeCellAddress(address);
    } catch {
      continue;
    }
    if (decoded.row < spanStart || decoded.row > spanEnd) continue;
    const label = encodeColumnLabel(decoded.column);
    if (only && !only.has(label)) continue;
    // Re-encoded from the decoded position rather than passed through, so this
    // key is formed by exactly the expression the row-store path uses. The
    // parser already normalises these addresses (`normalizeCellAddress` on the
    // way in), so this is not fixing an observed mismatch — it is refusing to
    // depend on that guarantee for a key an agent writes back to.
    entries.push({ row: decoded.row, label, address: `${label}${decoded.row + 1}`, format });
  }

  entries.sort((a, b) => a.row - b.row || compareColumnLabels(a.label, b.label));
  return entries.map((entry) => [entry.address, entry.format]);
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
  /**
   * Also describe the tab's presentation — regions, layout, column and cell
   * formats, conditional rules. Off by default: an agent reading data does not
   * need the styling, and this is the only part of the response whose size is
   * driven by how much someone has formatted rather than by what was asked for.
   */
  includeFormatting?: boolean;
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
    return windowFromDocument({
      content: options.documentContent,
      pageId,
      tabIndex,
      fromRow,
      limit,
      only,
      includeFormatting: options.includeFormatting,
    });
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
  // Prepared once for the whole window, not per cell: `createRegionResolver`
  // resolves every region's bounds, column roles and theme up front so the
  // closure it returns costs a bounds test per cell.
  //
  // Left OFF entirely when the tab declares no regions, rather than handed the
  // resolver's own no-op. Resolving a region needs the column INDEX, so a
  // present-but-empty resolver would still decode a label per cell — thousands
  // of decodes per read, on the sheets that have nothing to decode them for.
  const regions = parseRegions(tab.regions);
  const presentation: CellPresentation = {
    columnFormats: tab.columnFormats,
    ...(regions ? { regionAt: createRegionResolver(regions, tab.rowCount) } : {}),
  };
  const rows = stored.map((row) => toSheetViewRow(row.rowIndex, row.cells, only, presentation));
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
    // From what the fetch RETURNED, never from the tab's declared `rowCount`.
    // A tab can declare 500 rows while storing data only to row 60, so
    // comparing against the declared count claimed more rows after the window
    // that already held the last one — costing a guaranteed empty round trip.
    // A short page proves there is nothing further; a full one means there may
    // be. Same reasoning the document path above already used.
    hasMore: stored.length === limit,
    documentIsNotASheet: false,
    // `only` is passed for the same reason the rows are projected: `cellFormats`
    // is per-cell, so a projected read must project it too or the response is
    // bigger than the columns it claims to be about. The tab-level fields are
    // not per-cell and are not projected.
    ...(options.includeFormatting
      ? { formatting: buildSheetFormatting(tab, explicitCellFormats(stored, only)) }
      : {}),
  };
}

/**
 * A row window rendered as text and bounded by CHARACTERS, for the surfaces
 * where a sheet is a preview inside a larger payload.
 *
 * Row count alone does not bound anything: 25 rows of a 60-column sheet is tens
 * of thousands of characters. Whole rows are dropped until the text fits, so it
 * is never cut mid-row into something that reads like a real value; a single
 * row wider than the whole budget is still cut, on a line boundary, with the
 * ellipsis saying so.
 *
 * Shared because both callers reached for it independently and only one of them
 * had it: `list_pages` bounded by characters while command injection — whose
 * cost is paid on EVERY turn, not once per read — bounded only by rows.
 */
export function renderSheetTableWithinBudget(
  rows: readonly SheetViewRow[],
  budget: number,
  columns?: readonly string[],
): { text: string; rowsShown: number; truncatedCells: number } {
  // Dropping one row per re-render is O(rows^2) on exactly the input this
  // exists for: a 500-row read of a wide sheet sheds hundreds of rows, each
  // shedding costing a full re-render of everything still standing. Estimate
  // from the measured overshoot instead, then settle one row at a time — the
  // estimate is a ratio so it can undershoot, and the loop is the guarantee.
  let shown = rows;
  let rendered = renderSheetTable(shown, columns);
  if (rendered.text.length > budget && shown.length > 1) {
    const keep = Math.max(1, Math.floor(shown.length * (budget / rendered.text.length)));
    if (keep < shown.length) {
      shown = shown.slice(0, keep);
      rendered = renderSheetTable(shown, columns);
    }
  }
  while (rendered.text.length > budget && shown.length > 1) {
    shown = shown.slice(0, -1);
    rendered = renderSheetTable(shown, columns);
  }

  let text = rendered.text;
  let rowsShown = shown.length;
  if (text.length > budget) {
    // This cut is on the ESCAPED text, which one level down (`renderSheetTable`)
    // is exactly what the cell truncation refuses to do — cutting escaped output
    // can land between the halves of an escaped backslash, or inside a surrogate
    // pair, and emit something the reader cannot decode. It is safe HERE only
    // because of what can reach it: a prefix holding no newline is necessarily a
    // prefix of the HEADER, and the header is `columns→` plus column labels.
    // Labels are letters — `columnsInRows` reads keys that `encodeColumnLabel`
    // or the store's `assertColumn` produced, and the one caller passing
    // `columns` explicitly validates each against `/^[A-Za-z]{1,7}$/`. So the
    // raw branch below only ever cuts ASCII.
    //
    // Swept to confirm rather than argued: every budget from 0 to 400, over
    // single rows of emoji and of backslashes, and over a 60-column header
    // wider than the budget, takes the raw branch 318 times between them and
    // produces no lone surrogate and no odd trailing backslash — because every
    // one of those cuts landed inside `columns→...`. If a label ever becomes
    // free text, this cut needs a safe boundary computed before it, and this
    // comment is the reason why.
    const hardCut = text.slice(0, Math.max(0, budget));
    const lastNewline = hardCut.lastIndexOf('\n');
    text = `${lastNewline > 0 ? hardCut.slice(0, lastNewline) : hardCut}…`;
    // The loop stops at one row, so a single row wider than the whole budget
    // gets cut back to the `columns→…` header and NO data row survives.
    // Reporting `shown.length` then made both callers announce "First 1 row(s)
    // below" above nothing at all. Count what is actually there.
    rowsShown = Math.max(0, text.split('\n').length - 1);
  }
  return { text, rowsShown, truncatedCells: rendered.truncatedCells };
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
      // The delimiter is escaped for the same reason the newline is: a cell
      // containing " | " (free text, a piped path, a formula) would otherwise
      // produce a row with more apparent columns than the header, silently
      // shifting every value after it onto the wrong column letter.
      //
      // The BACKSLASH goes first, and that order is the whole correctness of
      // it. Escaping only the newline and the pipe left the escape character
      // itself ambiguous: a cell holding the literal text `a\|b` came out
      // identical to a cell holding `a|b`, so a reader could not tell an
      // escaped delimiter from a real backslash followed by one — and would
      // read the row's columns back wrong. Escaping backslashes first makes
      // every sequence decode to exactly one original.
      // TRUNCATE FIRST, then escape. Cutting the escaped string could land
      // between the two halves of an escaped backslash, emitting an odd number
      // of them before the ellipsis — the reader then cannot decode that cell,
      // which is precisely the ambiguity the escaping above exists to remove.
      // Measuring on the escaped form was also a lie in the other direction: a
      // cell full of backslashes or pipes was cut well before 120 original
      // characters while the response said it had been "cut at 120".
      const points = [...value];
      const cut = points.length > MAX_TABLE_CELL_CHARS;
      const original = cut ? points.slice(0, MAX_TABLE_CELL_CHARS).join('') : value;
      const flat = original
        .replace(/\\/g, '\\\\')
        .replace(/\r?\n/g, '\\n')
        .replace(/\|/g, '\\|');
      // Counted in CODE POINTS on the ORIGINAL, so the count means what the
      // response says it means, and a cut never splits a surrogate pair.
      if (!cut) return flat;
      truncatedCells++;
      return `${flat}…`;
    });
    lines.push(`${row.rowNumber}→${cells.join(' | ')}`);
  }
  return { text: lines.join('\n'), truncatedCells };
}

/** The character budget one cell gets in a rendered table. */
export const TABLE_CELL_CHAR_LIMIT = MAX_TABLE_CELL_CHARS;

// ---------------------------------------------------------------------------
// Formatting — what a sheet LOOKS like, for an agent that has to change it
// ---------------------------------------------------------------------------

/**
 * Characters the per-cell formatting map may spend.
 *
 * Deliberately small against the 40,000-char table budget, and the ratio is the
 * point: formatting is context to decide WITH, not the data that was asked for.
 * A read that spends a third of its response describing fills has crowded out
 * the rows the agent actually called for.
 *
 * It bounds only `cellFormats`, because that is the only unbounded part —
 * regions are a handful of declarations, layout is O(columns), and the rule
 * summaries are one line each under `MAX_CONDITIONAL_RULES`. Per-cell overrides
 * are O(cells) and a sheet someone styled by hand can have thousands.
 */
export const MAX_FORMATTING_CHARS = 6_000;

/** A conditional rule as an agent reads it: what it is and where, in one line. */
export interface ConditionalRuleSummary {
  id: string;
  kind: ConditionalRule['kind'];
  ranges: string[];
  summary: string;
}

/** Grid-wide presentation, carrying only the keys the tab actually sets. */
export interface SheetLayout {
  frozenRows?: number;
  frozenColumns?: number;
  columnWidths?: Record<string, number>;
  rowHeights?: Record<string, number>;
}

export interface SheetFormatting {
  /**
   * The tab's declared structure, verbatim.
   *
   * Verbatim is the whole value of it: these are re-writable AS the `regions`
   * input that declares them, so an agent adjusting one table's theme reads the
   * list, changes one field and writes it back — rather than inferring
   * structure from derived fills and re-deriving something subtly different.
   */
  regions?: SheetRegion[];
  layout?: SheetLayout;
  /** Per-column defaults, keyed by column letter. */
  columnFormats?: Record<string, CellFormat>;
  /**
   * Explicit per-cell overrides, keyed by A1 address — only cells that carry
   * their own format. Derived presentation is NOT here: it comes from
   * `regions`, and flattening it into per-cell entries would turn a rule back
   * into the residue the region model exists to replace.
   */
  cellFormats?: Record<string, CellFormat>;
  conditionalRules?: ConditionalRuleSummary[];
  /**
   * Present only when `cellFormats` was cut, with how many cells were left out.
   *
   * A silently partial map is worse than a bounded one: an agent reads "B7 has
   * no override" and writes as though that were true. The count says the
   * picture is incomplete and by how much.
   */
  formattingTruncated?: { droppedCells: number };
}

/**
 * Operator wording, duplicated from the sheet panel's `rule-presets` on purpose.
 *
 * `apps/web/src/lib/ai/**` imports nothing from `components/**` today, and this
 * is not the place to start that dependency — a tool module pulling in a UI
 * module drags the component tree's imports into every AI request. The cost of
 * the copy is drift, which is why a test asserts the two produce the same string
 * for a rule of each kind.
 */
const OPERATOR_WORDING: Record<ConditionalOperator, string> = {
  greaterThan: 'is greater than',
  greaterThanOrEqual: 'is greater than or equal to',
  lessThan: 'is less than',
  lessThanOrEqual: 'is less than or equal to',
  equal: 'is equal to',
  notEqual: 'is not equal to',
  between: 'is between',
  notBetween: 'is not between',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
  isError: 'is an error',
};

const VALUELESS: ReadonlySet<ConditionalOperator> = new Set<ConditionalOperator>([
  'isEmpty',
  'isNotEmpty',
  'isError',
]);

const TWO_BOUNDS: ReadonlySet<ConditionalOperator> = new Set<ConditionalOperator>([
  'between',
  'notBetween',
]);

function describeCondition(condition: ConditionalCondition): string {
  const label = OPERATOR_WORDING[condition.operator] ?? condition.operator;
  if (VALUELESS.has(condition.operator)) return label;
  if (TWO_BOUNDS.has(condition.operator)) {
    return `${label} ${condition.value || '?'} and ${condition.value2 || '?'}`;
  }
  return `${label} ${condition.value || '?'}`;
}

/**
 * One line saying what a conditional rule does.
 *
 * A line, never the rule's JSON. A colour scale's anchors and a data bar's
 * fill are render-layer detail an agent cannot act on without also owning the
 * rendering, and four of them at full fidelity cost more context than the rows
 * they describe. The `id` beside it is what identifies a rule to change it.
 */
export function describeConditionalRule(rule: ConditionalRule): string {
  switch (rule.kind) {
    case 'cell':
      return `Cell ${describeCondition(rule.condition)}`;
    case 'formula':
      return rule.formula ? `Formula ${rule.formula}` : 'Formula (not set)';
    case 'colorScale':
      return rule.mid ? 'Colour scale (3 colours)' : 'Colour scale';
    case 'dataBar':
      return 'Data bar';
  }
}

/** The tab fields formatting is read from — a subset of the store's `StoredTab`. */
export interface SheetFormattingSource {
  frozenRows?: number | null;
  frozenColumns?: number | null;
  columnFormats?: Record<string, CellFormat> | null;
  columnWidths?: Record<string, number> | null;
  rowHeights?: Record<string, number> | null;
  conditionalFormats?: unknown[] | null;
  regions?: unknown[] | null;
}

/**
 * A type guard rather than a boolean, so the caller does not need a non-null
 * assertion to use the map it has just proved is there.
 */
const hasKeys = <T extends Record<string, unknown>>(value: T | null | undefined): value is T =>
  value !== null && value !== undefined && Object.keys(value).length > 0;

/**
 * The explicit per-cell overrides carried by a window of stored rows, as
 * `[A1 address, format]` pairs.
 *
 * Deterministic order — rows as fetched, columns in sheet order — so the same
 * window always drops the same cells under the budget, and a re-read to check a
 * change does not silently swap which half of the sheet it describes.
 *
 * A row-store cell's `format` IS the explicit override: `sheetDataToRows` copies
 * only `sheet.formats[address]` onto it, leaving column defaults on the tab and
 * region-derived presentation to be derived at evaluation time. The document
 * path builds its own entries for exactly that reason — its synthetic cells
 * carry the RESOLVED format instead.
 */
export function explicitCellFormats(
  rows: readonly { rowIndex: number; cells: Record<string, StoredCell> }[],
  only?: ReadonlySet<string>,
): [string, CellFormat][] {
  const entries: [string, CellFormat][] = [];
  for (const row of rows) {
    for (const label of Object.keys(row.cells).sort(compareColumnLabels)) {
      if (only && !only.has(label)) continue;
      const format = row.cells[label]?.format;
      if (!format || Object.keys(format).length === 0) continue;
      entries.push([`${label}${row.rowIndex + 1}`, format]);
    }
  }
  return entries;
}

/** As many of `entries` as the budget affords, plus how many it left out. */
function withinFormattingBudget(
  entries: readonly (readonly [string, CellFormat])[],
  budget: number,
): { formats: Record<string, CellFormat>; dropped: number } {
  const formats: Record<string, CellFormat> = {};
  let spent = 0;
  let dropped = 0;

  for (const [address, format] of entries) {
    // The cost of the entry as it will be serialised: the key, the value, the
    // quotes and the comma. Measuring the value alone understated a map of
    // thousands of tiny formats by more than the formats themselves.
    const cost = address.length + JSON.stringify(format).length + 4;
    // Counted, not stopped at: the caller is told how many cells it is NOT
    // seeing, and a single oversized format must not make every later cell
    // vanish uncounted.
    if (spent + cost > budget) {
      dropped++;
      continue;
    }
    spent += cost;
    formats[address] = format;
  }

  return { formats, dropped };
}

/**
 * A tab's presentation, in the shape an agent can read and write back.
 *
 * Pure, and given the tab's own fields rather than a page id, so every caller —
 * a positional window, a filtered query, and the parsed-document fallback —
 * describes the same tab identically. It reads nothing: `SheetFormattingSource`
 * is satisfied by both a `sheet_tabs` row and a parsed `SheetData`, and the
 * per-cell entries are supplied by the caller that knows which of its cells
 * carry an EXPLICIT format rather than a resolved one.
 */
export function buildSheetFormatting(
  tab: SheetFormattingSource,
  cellFormats: readonly (readonly [string, CellFormat])[],
): SheetFormatting {
  const formatting: SheetFormatting = {};

  // Through the same parser the renderer uses, not straight off the column:
  // `regions` is API-writable jsonb, and handing an agent an unvalidated blob
  // as "the regions" would have it write back something the writer then drops.
  const regions = parseRegions(tab.regions);
  if (regions && regions.length > 0) formatting.regions = regions;

  const layout: SheetLayout = {};
  if (tab.frozenRows != null) layout.frozenRows = tab.frozenRows;
  if (tab.frozenColumns != null) layout.frozenColumns = tab.frozenColumns;
  if (hasKeys(tab.columnWidths)) layout.columnWidths = tab.columnWidths;
  if (hasKeys(tab.rowHeights)) layout.rowHeights = tab.rowHeights;
  if (Object.keys(layout).length > 0) formatting.layout = layout;

  if (hasKeys(tab.columnFormats)) formatting.columnFormats = tab.columnFormats;

  const cells = withinFormattingBudget(cellFormats, MAX_FORMATTING_CHARS);
  if (Object.keys(cells.formats).length > 0) formatting.cellFormats = cells.formats;
  if (cells.dropped > 0) formatting.formattingTruncated = { droppedCells: cells.dropped };

  const rules = parseConditionalRules(tab.conditionalFormats);
  if (rules && rules.length > 0) {
    formatting.conditionalRules = rules.map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      ranges: rule.ranges,
      summary: describeConditionalRule(rule),
    }));
  }

  return formatting;
}
