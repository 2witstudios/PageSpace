/**
 * `pagespace sheets …` — the spreadsheet command group.
 *
 * Two families sit here, over two different endpoints, because a sheet is two
 * things at once:
 *
 * - `edit-cells` treats it as a document you edit by A1 address, over
 *   `pages.editCells` (`/api/mcp/documents`). Predates the row store; kept
 *   verbatim so existing scripts keep working.
 * - `describe`/`query`/`rows`/`append`/`update-cells`/`delete-rows` treat it as
 *   a TABLE, over the `sheets.*` SDK operations (`/api/mcp/sheets`). These are
 *   what make a large sheet usable from a terminal: filter it server-side
 *   rather than dumping 100,000 rows through a pipe.
 *
 * `edit-cells` and `update-cells` overlap deliberately rather than by accident.
 * `edit-cells` reports richer per-cell stats but only ever addresses the FIRST
 * tab; `update-cells` takes `--tab`, so it is the one that can reach a
 * multi-tab sheet at all. Neither can be dropped without taking something away.
 *
 * ROW INDEXES ARE 0-BASED throughout, matching the API rather than the
 * spreadsheet UI's 1-based labels. `--from-row 0` is the first row, and what
 * these verbs print is what you can feed back in — translating for display
 * would make the printed number and the accepted flag disagree.
 *
 * `formatting`/`format` are a third family, over the same endpoint but about
 * PRESENTATION rather than data: declared regions, conditional rules, frozen
 * panes, column and cell formats. `formatting` reads (a noun: what the sheet
 * looks like now), `format` writes (a verb: apply these ops). Read before you
 * write — a region or rule you did not read is one you are about to replace.
 *
 * JSON-bearing flags (`--where`, and the row/cell/op payloads) are parsed here
 * only far enough to reject malformed JSON as a usage error (exit 2) before any
 * network call; the per-item shape is left to the SDK's zod schemas and the
 * server, matching every other thin verb.
 */
import process from 'node:process';
import type { PageSpaceClient, SheetFormatOpInput } from '@pagespace/sdk';
import { confirmationFailureMessage, confirmDestructive } from '../confirm.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { callSdk } from './sdk-error.js';

type QueryRowsResult = Awaited<ReturnType<PageSpaceClient['sheets']['queryRows']>>;
type GetRowsResult = Awaited<ReturnType<PageSpaceClient['sheets']['getRows']>>;
type DescribeResult = Awaited<ReturnType<PageSpaceClient['sheets']['describe']>>;
type ReadFormattingResult = Awaited<ReturnType<PageSpaceClient['sheets']['readFormatting']>>;
type ApplyFormatResult = Awaited<ReturnType<PageSpaceClient['sheets']['applyFormat']>>;

/** Pure: no I/O. */
function extractJsonInputFlag(
  args: readonly string[],
): { readonly ok: true; readonly jsonInput: string | undefined; readonly rest: readonly string[] } | { readonly ok: false; readonly message: string } {
  const rest: string[] = [];
  let jsonInput: string | undefined;
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--json-input') {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, message: 'Flag --json-input requires a value.' };
      jsonInput = value;
      i += 2;
      continue;
    }
    rest.push(args[i] as string);
    i += 1;
  }
  return { ok: true, jsonInput, rest };
}

type ValueFlagScan =
  | { readonly ok: true; readonly values: ReadonlyMap<string, string>; readonly rest: readonly string[] }
  | { readonly ok: false; readonly message: string };

/** Pure: no I/O. Consumes only the named value-taking flags; everything else passes through verbatim. */
function scanValueFlags(args: readonly string[], valueFlags: readonly string[]): ValueFlagScan {
  const values = new Map<string, string>();
  const rest: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i] as string;
    if (valueFlags.includes(token)) {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, message: `Flag ${token} requires a value.` };
      values.set(token, value);
      i += 2;
      continue;
    }
    rest.push(token);
    i += 1;
  }
  return { ok: true, values, rest };
}

/** Pure: no I/O. */
function parseIntFlag(
  raw: string | undefined,
  flagName: string,
  min: number,
): { readonly ok: true; readonly value: number | undefined } | { readonly ok: false; readonly message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    return { ok: false, message: `Invalid ${flagName} "${raw}": must be an integer >= ${min}.` };
  }
  return { ok: true, value: parsed };
}

/**
 * Pure: no I/O. `{ tabIndex: 2 }` for a value, `{}` for `undefined`.
 *
 * Cosmetic, not load-bearing — checked rather than assumed: zod accepts an
 * explicit `undefined` for an optional key (`strictObject` rejects UNKNOWN
 * keys, which is a different thing), and `JSON.stringify` drops it before it
 * reaches the wire regardless. This exists so a call site with six optional
 * fields reads as six named fields instead of six copies of one ternary.
 */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Pure: no I/O. `A,B,C` -> `['A','B','C']`; empty entries dropped so a trailing
 * comma is not an error.
 *
 * Serves `--select` (column letters) and `--ranges` (A1 rectangles) alike: a
 * column letter and an A1 range both exclude the comma, so splitting on one is
 * unambiguous for either.
 */
function parseCommaList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

/**
 * Pure: no I/O. `A:desc,B` -> `[{column:'A',direction:'desc'},{column:'B'}]`.
 * An unrecognised direction is a usage error rather than a silent `asc`, which
 * would return a confidently wrong ordering.
 */
function parseOrderBy(
  raw: string | undefined,
): { readonly ok: true; readonly value: Array<{ column: string; direction?: 'asc' | 'desc' }> | undefined } | { readonly ok: false; readonly message: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const parsed: Array<{ column: string; direction?: 'asc' | 'desc' }> = [];
  for (const entry of entries) {
    const [column, direction] = entry.split(':');
    if (!column) return { ok: false, message: `Invalid --order-by entry "${entry}".` };
    if (direction === undefined) {
      parsed.push({ column });
      continue;
    }
    if (direction !== 'asc' && direction !== 'desc') {
      return { ok: false, message: `Invalid sort direction "${direction}" in --order-by: use asc or desc.` };
    }
    parsed.push({ column, direction });
  }
  return { ok: true, value: parsed.length > 0 ? parsed : undefined };
}

type RenderableRow = { readonly rowIndex: number; readonly cells: Record<string, { raw: string; value?: unknown }> };

/**
 * Pure: no I/O. Spreadsheet column order, which is not lexicographic.
 *
 * Labels are bijective base-26, so `AA` follows `Z` — but as strings `AA` sorts
 * before `B`. Length first, then letters, which is exactly the numeric order of
 * the underlying column index for any valid label. A plain `.sort()` printed
 * `AA` before `B` on any sheet wider than 26 columns.
 */
export function compareColumns(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pure: no I/O. One line per row, columns in spreadsheet order.
 *
 * Prints the COMPUTED value where a cell has one, so a formula column reads as
 * its result rather than its source — the same value the filters matched on.
 * Only a genuinely ABSENT value falls back to `raw`: a formula that evaluates
 * to the empty string (an `IF` branch returning blank, say) has a real
 * materialised value of `''`, and printing its source instead made the human
 * output disagree with what the filter had matched.
 */
export function renderRows(rows: readonly RenderableRow[]): string {
  if (rows.length === 0) return 'No rows.\n';
  return `${rows
    .map((row) => {
      const cells = Object.keys(row.cells)
        .sort(compareColumns)
        .map((column) => {
          const cell = row.cells[column]!;
          const shown = cell.value === undefined || cell.value === null ? cell.raw : String(cell.value);
          return `${column}=${shown}`;
        })
        .join('  ');
      return `row ${row.rowIndex}: ${cells}`;
    })
    .join('\n')}\n`;
}

/** Pure: no I/O. */
export function renderQueryRows(value: QueryRowsResult): string {
  const shown = renderRows(value.rows as RenderableRow[]);
  if (value.rows.length === 0) return shown;
  return `${shown}${value.rows.length} of ${value.total} matching row(s)${value.hasMore ? ', more available' : ''}.\n`;
}

/** Pure: no I/O. */
export function renderGetRows(value: GetRowsResult): string {
  const shown = renderRows(value.rows as RenderableRow[]);
  if (value.rows.length === 0) return shown;
  // The continuation cursor, not a count — paging a sparse tab by row count
  // would revisit the same rows forever.
  const next = value.hasMore && value.nextFromRow !== null ? ` Next: --from-row ${value.nextFromRow}` : '';
  return `${shown}${value.rows.length} row(s) of ${value.rowCount}.${next}\n`;
}

/** Pure: no I/O. */
export function renderDescribe(value: DescribeResult): string {
  if (value.tabs.length === 0) return 'No tabs.\n';
  return `${value.tabs
    .map((tab) => `tab ${tab.tabIndex}: ${tab.name} — ${tab.rowCount} rows x ${tab.columnCount} columns${tab.frozenRows ? ` (${tab.frozenRows} frozen)` : ''}`)
    .join('\n')}\n`;
}

/** Pure: no I/O. `{bold: true, number: {kind: 'currency'}}` -> `bold, number=currency`. */
function summarizeFormat(format: Readonly<Record<string, unknown>>): string {
  const parts = Object.entries(format).map(([key, value]) => {
    if (value === true) return key;
    if (value !== null && typeof value === 'object') {
      const kind = (value as { kind?: unknown }).kind;
      return typeof kind === 'string' ? `${key}=${kind}` : key;
    }
    return `${key}=${String(value)}`;
  });
  return parts.length > 0 ? parts.join(', ') : '(empty)';
}

/** Pure: no I/O. `{type: 'number', value: 5}` -> `5`; `{type: 'min'}` -> `min`. */
function summarizeAnchor(anchor: { type: string; value?: number; color?: string }): string {
  const base = anchor.value === undefined ? anchor.type : `${anchor.type} ${anchor.value}`;
  return anchor.color === undefined ? base : `${base} ${anchor.color}`;
}

/** Pure: no I/O. One line per rule, enough to tell two rules apart and to pick an id to remove. */
function summarizeRule(rule: ReadFormattingResult['conditionalFormats'][number]): string {
  const where = rule.ranges.join(',');
  switch (rule.kind) {
    case 'cell': {
      const { operator, value, value2 } = rule.condition;
      const operand = [value, value2].filter((entry) => entry !== undefined).join('..');
      return `${rule.id}: cell ${where} ${operator}${operand ? ` ${operand}` : ''} -> ${summarizeFormat(rule.format)}`;
    }
    case 'formula':
      return `${rule.id}: formula ${where} ${rule.formula} -> ${summarizeFormat(rule.format)}`;
    case 'colorScale': {
      const mid = rule.mid === undefined ? '' : ` .. ${summarizeAnchor(rule.mid)}`;
      return `${rule.id}: colorScale ${where} ${summarizeAnchor(rule.min)}${mid} .. ${summarizeAnchor(rule.max)}`;
    }
    case 'dataBar': {
      const bounds = [rule.min, rule.max].filter((entry) => entry !== undefined).map(summarizeAnchor).join(' .. ');
      return `${rule.id}: dataBar ${where} ${rule.color}${bounds ? ` (${bounds})` : ''}`;
    }
  }
}

/** Pure: no I/O. */
function summarizeRegion(region: ReadFormattingResult['regions'][number]): string {
  const name = region.name === undefined ? '' : ` "${region.name}"`;
  const bits = [
    // Stated even at its default, because a reader deciding whether to
    // re-declare the region needs to know what it will be compared against.
    `${region.headerRows ?? 1} header row(s)`,
    ...(region.totalRows && region.totalRows.length > 0 ? [`totals ${region.totalRows.join(',')}`] : []),
    ...(region.theme === undefined ? [] : [`theme ${region.theme}`]),
  ];
  const columns = (region.columns ?? []).map((column) => {
    const detail = [column.currency, column.decimals === undefined ? undefined : `${column.decimals}dp`]
      .filter((entry) => entry !== undefined)
      .join(' ');
    return `${column.column}=${column.role}${detail ? ` (${detail})` : ''}`;
  });
  return `${region.id}${name} ${region.range} — ${bits.join(', ')}${columns.length > 0 ? `\n    ${columns.join(', ')}` : ''}`;
}

/**
 * Pure: no I/O. A section is omitted entirely when empty, so what IS set stands
 * out.
 *
 * `requestedRanges` is the caller's `--ranges`, not anything the response
 * carries: the SDK returns an empty `cellFormats` both when no ranges were
 * asked for and when the ranges asked for hold no explicit formats, and those
 * are different answers. Reading the first as the second would tell someone
 * their cells are unformatted when nothing was ever read.
 */
export function renderFormatting(value: ReadFormattingResult, requestedRanges?: readonly string[]): string {
  const lines: string[] = [
    `tab ${value.tabIndex}: ${value.rowCount} rows x ${value.columnCount} columns`,
  ];
  if (value.frozenRows !== null || value.frozenColumns !== null) {
    lines.push(`frozen: ${value.frozenRows ?? 0} row(s), ${value.frozenColumns ?? 0} column(s)`);
  }
  if (value.regions.length > 0) {
    lines.push(`regions (${value.regions.length}):`, ...value.regions.map((region) => `  ${summarizeRegion(region)}`));
  }
  if (value.conditionalFormats.length > 0) {
    lines.push(
      `conditional rules (${value.conditionalFormats.length}):`,
      ...value.conditionalFormats.map((rule) => `  ${summarizeRule(rule)}`),
    );
  }
  const columnFormats = Object.entries(value.columnFormats);
  if (columnFormats.length > 0) {
    lines.push('column formats:', ...columnFormats.map(([column, format]) => `  ${column}: ${summarizeFormat(format)}`));
  }
  const columnWidths = Object.entries(value.columnWidths);
  if (columnWidths.length > 0) {
    lines.push(`column widths: ${columnWidths.map(([column, width]) => `${column}=${width}`).join(', ')}`);
  }
  const rowHeights = Object.entries(value.rowHeights);
  if (rowHeights.length > 0) {
    lines.push(`row heights: ${rowHeights.map(([row, height]) => `${row}=${height}`).join(', ')}`);
  }
  const cellFormats = Object.entries(value.cellFormats);
  if (cellFormats.length > 0) {
    lines.push('cell formats:', ...cellFormats.map(([address, format]) => `  ${address}: ${summarizeFormat(format)}`));
  } else if (requestedRanges !== undefined && requestedRanges.length > 0) {
    // Ranges WERE read and hold nothing explicit. A real answer, and the only
    // one that licenses "these cells carry no per-cell format of their own".
    lines.push(`cell formats: none found in ${requestedRanges.join(', ')}`);
  } else {
    // Nothing was read at all. Not the same as "none", and a caller that read
    // it as "no cell formatting" would format straight over what is there.
    lines.push('cell formats: none read (pass --ranges to read per-cell formats)');
  }
  return `${lines.join('\n')}\n`;
}

/** Pure: no I/O. */
export function renderApplyFormat(value: ApplyFormatResult): string {
  if (!value.changed) {
    return 'No change — the sheet already had this formatting.\n';
  }
  const bits = [
    ...(value.cellsFormatted > 0 ? [`${value.cellsFormatted} cell(s) restyled`] : []),
    ...(value.tabFieldsChanged.length > 0 ? [`changed ${value.tabFieldsChanged.join(', ')}`] : []),
    ...(value.regionIdsAdded.length > 0 ? [`+${value.regionIdsAdded.length} region(s)`] : []),
    ...(value.regionIdsRemoved.length > 0 ? [`-${value.regionIdsRemoved.length} region(s)`] : []),
    ...(value.ruleIdsAdded.length > 0 ? [`+${value.ruleIdsAdded.length} rule(s)`] : []),
    ...(value.ruleIdsRemoved.length > 0 ? [`-${value.ruleIdsRemoved.length} rule(s)`] : []),
  ];
  return `Formatted ${value.pageId} (tab ${value.tabIndex}): ${bits.join('; ')}. ${value.regions} region(s) and ${value.conditionalRules} rule(s) now on the tab.\n`;
}

/**
 * The stdin seam, shared by every verb that takes a JSON payload. Was
 * `SheetsEditCellsDeps` when `edit-cells` was the only one; renamed rather than
 * aliased, because an unused alias is dead code the repo's knip gate rejects
 * and nothing in or out of this monorepo imports the type by name.
 */
export interface SheetsStdinDeps {
  readonly readStdin: () => Promise<string>;
}

export function createSheetsEditCellsHandler(deps: SheetsStdinDeps): CommandHandler {
  return async (ctx, intent) => {
    const [pageId, ...rest0] = intent.args;
    if (!pageId) {
      ctx.stderr.write('Usage: pagespace sheets edit-cells <pageId> [--json-input <json>]\n');
      return EXIT_USAGE_ERROR;
    }

    const inputFlag = extractJsonInputFlag(rest0);
    if (!inputFlag.ok) {
      ctx.stderr.write(`${inputFlag.message}\n`);
      return EXIT_USAGE_ERROR;
    }
    if (inputFlag.rest.length > 0) {
      ctx.stderr.write(`Unknown argument: ${inputFlag.rest[0]}\n`);
      return EXIT_USAGE_ERROR;
    }

    let raw: string;
    try {
      raw = inputFlag.jsonInput !== undefined ? inputFlag.jsonInput : await deps.readStdin();
    } catch (error) {
      ctx.stderr.write(`Failed to read input: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    let cells: unknown;
    try {
      cells = JSON.parse(raw);
    } catch {
      ctx.stderr.write('Invalid JSON in --json-input/stdin.\n');
      return EXIT_USAGE_ERROR;
    }
    if (!Array.isArray(cells)) {
      ctx.stderr.write('Input must be a JSON array of {address, value} cells.\n');
      return EXIT_USAGE_ERROR;
    }

    const result = await callSdk(ctx.stderr, () =>
      ctx.sdk.pages.editCells({ operation: 'edit-cells', pageId, cells: cells as Array<{ address: string; value: string }> }),
    );
    if (!result.ok) return EXIT_RUNTIME_ERROR;

    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    } else {
      ctx.stdout.write(`Updated ${result.value.cellsUpdated} cell(s) in ${pageId}.\n`);
    }
    return EXIT_SUCCESS;
  };
}

export const sheetsDescribeHandler: CommandHandler = async (ctx, intent) => {
  const [pageId, ...extra] = intent.args;
  if (!pageId || extra.length > 0) {
    ctx.stderr.write('Usage: pagespace sheets describe <pageId>\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.sheets.describe({ operation: 'describe', pageId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  ctx.stdout.write(intent.flags.json ? `${JSON.stringify(result.value)}\n` : renderDescribe(result.value));
  return EXIT_SUCCESS;
};

export const sheetsQueryHandler: CommandHandler = async (ctx, intent) => {
  const usage = 'Usage: pagespace sheets query <pageId> [--where <json>] [--select A,B] [--order-by A:desc] [--limit <n>] [--offset <n>] [--tab <n>]\n';
  const [pageId, ...rest0] = intent.args;
  if (!pageId) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }

  const scan = scanValueFlags(rest0, ['--where', '--select', '--order-by', '--limit', '--offset', '--tab']);
  if (!scan.ok) {
    ctx.stderr.write(`${scan.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (scan.rest.length > 0) {
    ctx.stderr.write(`Unknown argument: ${scan.rest[0]}\n`);
    return EXIT_USAGE_ERROR;
  }

  const limit = parseIntFlag(scan.values.get('--limit'), '--limit', 1);
  if (!limit.ok) {
    ctx.stderr.write(`${limit.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const offset = parseIntFlag(scan.values.get('--offset'), '--offset', 0);
  if (!offset.ok) {
    ctx.stderr.write(`${offset.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const tabIndex = parseIntFlag(scan.values.get('--tab'), '--tab', 0);
  if (!tabIndex.ok) {
    ctx.stderr.write(`${tabIndex.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const orderBy = parseOrderBy(scan.values.get('--order-by'));
  if (!orderBy.ok) {
    ctx.stderr.write(`${orderBy.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const select = parseCommaList(scan.values.get('--select'));

  const rawWhere = scan.values.get('--where');
  let where: unknown;
  if (rawWhere !== undefined) {
    try {
      where = JSON.parse(rawWhere);
    } catch {
      ctx.stderr.write('Invalid JSON in --where.\n');
      return EXIT_USAGE_ERROR;
    }
  }

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.sheets.queryRows({
      operation: 'query-rows',
      pageId,
      ...optional('tabIndex', tabIndex.value),
      ...optional('where', where as never),
      ...optional('orderBy', orderBy.value),
      ...optional('select', select),
      ...optional('limit', limit.value),
      ...optional('offset', offset.value),
    }),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  ctx.stdout.write(intent.flags.json ? `${JSON.stringify(result.value)}\n` : renderQueryRows(result.value));
  return EXIT_SUCCESS;
};

export const sheetsRowsHandler: CommandHandler = async (ctx, intent) => {
  const usage = 'Usage: pagespace sheets rows <pageId> [--from-row <n>] [--limit <n>] [--tab <n>]\n';
  const [pageId, ...rest0] = intent.args;
  if (!pageId) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }

  const scan = scanValueFlags(rest0, ['--from-row', '--limit', '--tab']);
  if (!scan.ok) {
    ctx.stderr.write(`${scan.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (scan.rest.length > 0) {
    ctx.stderr.write(`Unknown argument: ${scan.rest[0]}\n`);
    return EXIT_USAGE_ERROR;
  }

  const fromRow = parseIntFlag(scan.values.get('--from-row'), '--from-row', 0);
  if (!fromRow.ok) {
    ctx.stderr.write(`${fromRow.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const limit = parseIntFlag(scan.values.get('--limit'), '--limit', 1);
  if (!limit.ok) {
    ctx.stderr.write(`${limit.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const tabIndex = parseIntFlag(scan.values.get('--tab'), '--tab', 0);
  if (!tabIndex.ok) {
    ctx.stderr.write(`${tabIndex.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.sheets.getRows({
      operation: 'get-rows',
      pageId,
      ...optional('tabIndex', tabIndex.value),
      ...optional('fromRow', fromRow.value),
      ...optional('limit', limit.value),
    }),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  ctx.stdout.write(intent.flags.json ? `${JSON.stringify(result.value)}\n` : renderGetRows(result.value));
  return EXIT_SUCCESS;
};

export function createSheetsAppendHandler(deps: SheetsStdinDeps): CommandHandler {
  return async (ctx, intent) => {
    const usage = 'Usage: pagespace sheets append <pageId> [--json-input <json>] [--tab <n>]\n';
    const [pageId, ...rest0] = intent.args;
    if (!pageId) {
      ctx.stderr.write(usage);
      return EXIT_USAGE_ERROR;
    }

    const scan = scanValueFlags(rest0, ['--json-input', '--tab']);
    if (!scan.ok) {
      ctx.stderr.write(`${scan.message}\n`);
      return EXIT_USAGE_ERROR;
    }
    if (scan.rest.length > 0) {
      ctx.stderr.write(`Unknown argument: ${scan.rest[0]}\n`);
      return EXIT_USAGE_ERROR;
    }
    const tabIndex = parseIntFlag(scan.values.get('--tab'), '--tab', 0);
    if (!tabIndex.ok) {
      ctx.stderr.write(`${tabIndex.message}\n`);
      return EXIT_USAGE_ERROR;
    }

    let raw: string;
    try {
      const inline = scan.values.get('--json-input');
      raw = inline !== undefined ? inline : await deps.readStdin();
    } catch (error) {
      ctx.stderr.write(`Failed to read input: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    let rows: unknown;
    try {
      rows = JSON.parse(raw);
    } catch {
      ctx.stderr.write('Invalid JSON in --json-input/stdin.\n');
      return EXIT_USAGE_ERROR;
    }
    if (!Array.isArray(rows)) {
      ctx.stderr.write('Input must be a JSON array of rows, each mapping column letters to cell text.\n');
      return EXIT_USAGE_ERROR;
    }

    const result = await callSdk(ctx.stderr, () =>
      ctx.sdk.sheets.appendRows({
        operation: 'append-rows',
        pageId,
        ...optional('tabIndex', tabIndex.value),
        rows: rows as Array<Record<string, string>>,
      }),
    );
    if (!result.ok) return EXIT_RUNTIME_ERROR;

    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    } else {
      ctx.stdout.write(`Appended ${result.value.appended} row(s) to ${pageId} starting at row ${result.value.firstRowIndex}.\n`);
    }
    return EXIT_SUCCESS;
  };
}

export function createSheetsUpdateCellsHandler(deps: SheetsStdinDeps): CommandHandler {
  return async (ctx, intent) => {
    const usage = 'Usage: pagespace sheets update-cells <pageId> [--json-input <json>] [--tab <n>]\n';
    const [pageId, ...rest0] = intent.args;
    if (!pageId) {
      ctx.stderr.write(usage);
      return EXIT_USAGE_ERROR;
    }

    const scan = scanValueFlags(rest0, ['--json-input', '--tab']);
    if (!scan.ok) {
      ctx.stderr.write(`${scan.message}\n`);
      return EXIT_USAGE_ERROR;
    }
    if (scan.rest.length > 0) {
      ctx.stderr.write(`Unknown argument: ${scan.rest[0]}\n`);
      return EXIT_USAGE_ERROR;
    }
    const tabIndex = parseIntFlag(scan.values.get('--tab'), '--tab', 0);
    if (!tabIndex.ok) {
      ctx.stderr.write(`${tabIndex.message}\n`);
      return EXIT_USAGE_ERROR;
    }

    let raw: string;
    try {
      const inline = scan.values.get('--json-input');
      raw = inline !== undefined ? inline : await deps.readStdin();
    } catch (error) {
      ctx.stderr.write(`Failed to read input: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    let cells: unknown;
    try {
      cells = JSON.parse(raw);
    } catch {
      ctx.stderr.write('Invalid JSON in --json-input/stdin.\n');
      return EXIT_USAGE_ERROR;
    }
    if (!Array.isArray(cells)) {
      ctx.stderr.write('Input must be a JSON array of {address, value} cells.\n');
      return EXIT_USAGE_ERROR;
    }

    const result = await callSdk(ctx.stderr, () =>
      ctx.sdk.sheets.updateCells({
        operation: 'update-cells',
        pageId,
        ...optional('tabIndex', tabIndex.value),
        cells: cells as Array<{ address: string; value: string }>,
      }),
    );
    if (!result.ok) return EXIT_RUNTIME_ERROR;

    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    } else {
      ctx.stdout.write(`Updated ${result.value.cellsUpdated} cell(s) in ${pageId}; recomputed ${result.value.recomputed}.\n`);
    }
    return EXIT_SUCCESS;
  };
}

export const sheetsDeleteRowsHandler: CommandHandler = async (ctx, intent) => {
  const usage = 'Usage: pagespace sheets delete-rows <pageId> --from-row <n> --count <n> [--tab <n>] [--yes]\n';
  const [pageId, ...rest0] = intent.args;
  if (!pageId) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }

  const scan = scanValueFlags(rest0, ['--from-row', '--count', '--tab']);
  if (!scan.ok) {
    ctx.stderr.write(`${scan.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (scan.rest.length > 0) {
    ctx.stderr.write(`Unknown argument: ${scan.rest[0]}\n`);
    return EXIT_USAGE_ERROR;
  }

  const fromRow = parseIntFlag(scan.values.get('--from-row'), '--from-row', 0);
  if (!fromRow.ok) {
    ctx.stderr.write(`${fromRow.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const count = parseIntFlag(scan.values.get('--count'), '--count', 1);
  if (!count.ok) {
    ctx.stderr.write(`${count.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const tabIndex = parseIntFlag(scan.values.get('--tab'), '--tab', 0);
  if (!tabIndex.ok) {
    ctx.stderr.write(`${tabIndex.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  // Neither bound is defaulted. A guessed `--count` deletes the wrong rows, and
  // there is no undo for that — the server refuses too.
  if (fromRow.value === undefined || count.value === undefined) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }
  // Bound to locals: the `await` below resets TypeScript's narrowing of these
  // properties, and a cast at the call site would assert what the guard has
  // already proven.
  const firstRow = fromRow.value;
  const rowsToDelete = count.value;

  // The same gate every other destructive verb uses. This one needs it MOST:
  // `pages trash` is reversible and still confirms, while deleting rows is not
  // — the rows are gone and everything below them shifts up. A typo in the
  // page, tab, start or count destroyed data with no prompt, and a non-TTY
  // caller was not required to pass `--yes`.
  const confirmation = await confirmDestructive(
    `Delete ${rowsToDelete} row(s) from ${pageId} starting at row ${firstRow}${tabIndex.value === undefined ? '' : ` (tab ${tabIndex.value})`}? This cannot be undone. [y/N] `,
    { isTTY: ctx.isTTY, yes: intent.flags.yes, prompt: ctx.prompt },
  );
  if (!confirmation.ok) {
    ctx.stderr.write(`${confirmationFailureMessage(confirmation)}\n`);
    return EXIT_RUNTIME_ERROR;
  }

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.sheets.deleteRows({
      operation: 'delete-rows',
      pageId,
      ...optional('tabIndex', tabIndex.value),
      fromRow: firstRow,
      count: rowsToDelete,
    }),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Deleted ${result.value.deleted} row(s) from ${pageId}.\n`);
  }
  return EXIT_SUCCESS;
};

export const sheetsFormattingHandler: CommandHandler = async (ctx, intent) => {
  const usage = 'Usage: pagespace sheets formatting <pageId> [--ranges A1:F40,H2:H9] [--tab <n>]\n';
  const [pageId, ...rest0] = intent.args;
  if (!pageId) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }

  const scan = scanValueFlags(rest0, ['--ranges', '--tab']);
  if (!scan.ok) {
    ctx.stderr.write(`${scan.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (scan.rest.length > 0) {
    ctx.stderr.write(`Unknown argument: ${scan.rest[0]}\n`);
    return EXIT_USAGE_ERROR;
  }
  const tabIndex = parseIntFlag(scan.values.get('--tab'), '--tab', 0);
  if (!tabIndex.ok) {
    ctx.stderr.write(`${tabIndex.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  // Bound before the call, because the renderer needs to know whether ranges
  // were ASKED for — the response cannot say.
  const ranges = parseCommaList(scan.values.get('--ranges'));

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.sheets.readFormatting({
      operation: 'read-formatting',
      pageId,
      ...optional('tabIndex', tabIndex.value),
      // Per-cell formats live on the rows, so they are read only for the
      // rectangles asked for. Without `--ranges` the declarative layer —
      // regions, rules, column defaults, freezes — comes back on its own.
      ...optional('ranges', ranges),
    }),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  ctx.stdout.write(intent.flags.json ? `${JSON.stringify(result.value)}\n` : renderFormatting(result.value, ranges));
  return EXIT_SUCCESS;
};

/**
 * `sheets format` — apply an ordered list of `SheetFormatOp`s.
 *
 * The payload is the op array itself rather than a flag per kind of formatting,
 * because the ops are order-dependent and applied in ONE transaction: a
 * `clearCellFormat` after a `setCellFormat` over the same cells means something
 * different from the reverse, and there is no flag ordering that expresses that
 * reliably. One flag per op kind would also have to grow every time the union
 * does, while this verb does not.
 *
 * No `--yes` gate, unlike `delete-rows`. Formatting is presentation: writing it
 * again restores it, so demanding a confirmation for "bold the header row"
 * would buy nothing and train the habit of passing `--yes` blind.
 */
export function createSheetsFormatHandler(deps: SheetsStdinDeps): CommandHandler {
  return async (ctx, intent) => {
    const usage = 'Usage: pagespace sheets format <pageId> [--json-input <json>] [--tab <n>]\n';
    const [pageId, ...rest0] = intent.args;
    if (!pageId) {
      ctx.stderr.write(usage);
      return EXIT_USAGE_ERROR;
    }

    const scan = scanValueFlags(rest0, ['--json-input', '--tab']);
    if (!scan.ok) {
      ctx.stderr.write(`${scan.message}\n`);
      return EXIT_USAGE_ERROR;
    }
    if (scan.rest.length > 0) {
      ctx.stderr.write(`Unknown argument: ${scan.rest[0]}\n`);
      return EXIT_USAGE_ERROR;
    }
    const tabIndex = parseIntFlag(scan.values.get('--tab'), '--tab', 0);
    if (!tabIndex.ok) {
      ctx.stderr.write(`${tabIndex.message}\n`);
      return EXIT_USAGE_ERROR;
    }

    let raw: string;
    try {
      const inline = scan.values.get('--json-input');
      raw = inline !== undefined ? inline : await deps.readStdin();
    } catch (error) {
      ctx.stderr.write(`Failed to read input: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    let ops: unknown;
    try {
      ops = JSON.parse(raw);
    } catch {
      ctx.stderr.write('Invalid JSON in --json-input/stdin.\n');
      return EXIT_USAGE_ERROR;
    }
    if (!Array.isArray(ops)) {
      ctx.stderr.write(
        'Input must be a JSON array of format ops, e.g. ' +
        '[{"type":"upsertRegion","region":{"id":"r1","range":"A1:F","headerRows":1}}].\n',
      );
      return EXIT_USAGE_ERROR;
    }

    const result = await callSdk(ctx.stderr, () =>
      ctx.sdk.sheets.applyFormat({
        operation: 'apply-format',
        pageId,
        ...optional('tabIndex', tabIndex.value),
        // Cast, not validation. The SDK's zod union refuses an op that is not
        // in it, and the server's `planFormatOps` refuses one it cannot plan —
        // naming the index. Re-deciding either here would give this verb a
        // third opinion about what a valid op is, and it would be the one that
        // goes stale.
        ops: ops as SheetFormatOpInput[],
      }),
    );
    if (!result.ok) return EXIT_RUNTIME_ERROR;

    ctx.stdout.write(intent.flags.json ? `${JSON.stringify(result.value)}\n` : renderApplyFormat(result.value));
    return EXIT_SUCCESS;
  };
}

async function readStdinToString(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export const sheetsEditCellsHandler: CommandHandler = createSheetsEditCellsHandler({ readStdin: readStdinToString });
export const sheetsAppendHandler: CommandHandler = createSheetsAppendHandler({ readStdin: readStdinToString });
export const sheetsUpdateCellsHandler: CommandHandler = createSheetsUpdateCellsHandler({ readStdin: readStdinToString });
export const sheetsFormatHandler: CommandHandler = createSheetsFormatHandler({ readStdin: readStdinToString });
