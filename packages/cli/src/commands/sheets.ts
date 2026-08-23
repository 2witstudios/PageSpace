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
 * JSON-bearing flags (`--where`, and the row/cell payloads) are parsed here
 * only far enough to reject malformed JSON as a usage error (exit 2) before any
 * network call; the per-item shape is left to the SDK's zod schemas and the
 * server, matching every other thin verb.
 */
import process from 'node:process';
import type { PageSpaceClient } from '@pagespace/sdk';
import { confirmationFailureMessage, confirmDestructive } from '../confirm.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { callSdk } from './sdk-error.js';

type QueryRowsResult = Awaited<ReturnType<PageSpaceClient['sheets']['queryRows']>>;
type GetRowsResult = Awaited<ReturnType<PageSpaceClient['sheets']['getRows']>>;
type DescribeResult = Awaited<ReturnType<PageSpaceClient['sheets']['describe']>>;

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

/** Pure: no I/O. `A,B,C` -> `['A','B','C']`; empty entries dropped so a trailing comma is not an error. */
function parseColumnList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const columns = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return columns.length > 0 ? columns : undefined;
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

  const select = parseColumnList(scan.values.get('--select'));

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
