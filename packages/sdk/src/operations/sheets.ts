/**
 * Sheet ROWS — the tabular view of a spreadsheet, over POST `/api/mcp/sheets`
 * (`apps/web/src/app/api/mcp/sheets/route.ts`), dispatched by an `operation`
 * field like the documents endpoint.
 *
 * Separate from `pages.editCells` on purpose. That verb edits a sheet the way a
 * person does — by A1 address, one cell at a time — and stays on
 * `/api/mcp/documents`. These operations treat the same data as a table: filter
 * it, sort it, page it, append to it. The distinction is not cosmetic. A sheet
 * is now stored row by row rather than as one document, so "give me the rows
 * where status is open" is a query the database answers, not something a caller
 * does by pulling the whole sheet into memory and filtering there.
 *
 * Filters run against the MATERIALISED value, so a formula column compares as
 * its result: `=B2*C2` filters as `7.5`, not as the formula text.
 *
 * All six are POST, so the client's idempotent-retry path already excludes them
 * (`isIdempotentMethod` is method-based) — no per-operation flag to thread.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

const SHEETS_PATH = '/api/mcp/sheets';

/**
 * Seven letters, matching the route's `columnSchema` and the store's
 * `assertColumn`. Capping at three would silently make every column past ZZZ
 * unfilterable, unsortable and unprojectable — as a 400 on valid input.
 */
const columnSchema = z.string().regex(/^[A-Za-z]{1,7}$/, 'Column must be letters, e.g. "A" or "AB"');

/** A1-style, e.g. `B7`. The route applies the same shape before the store bounds it. */
const cellAddressSchema = z.string().regex(/^[A-Za-z]+\d+$/, 'Use A1-style addresses, e.g. "B7"');

/**
 * Page size ceiling, mirroring `MAX_ROW_PAGE_SIZE` in
 * `@pagespace/lib/sheets/store`. Duplicated as a literal because the SDK does
 * not depend on `lib` — it is a wire contract here, and the route rejects
 * anything larger regardless.
 */
const MAX_ROW_PAGE_SIZE = 5_000;

const comparisonValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);

const conditionSchema = z.object({
  column: columnSchema,
  op: z.enum([
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'contains', 'startsWith', 'endsWith',
    'isEmpty', 'isNotEmpty', 'in',
  ]),
  /** Omitted for `isEmpty`/`isNotEmpty`; an array only for `in`. */
  value: comparisonValueSchema.optional(),
});

/** The recursive filter shape. `z.lazy` needs the annotation to terminate. */
export type SheetWhereInput =
  | z.infer<typeof conditionSchema>
  | { and: SheetWhereInput[] }
  | { or: SheetWhereInput[] }
  | { not: SheetWhereInput };

/**
 * Breadth is capped at 64 per group here and depth is bounded again inside the
 * server's `compileWhere` — this is the outer guard, not the only one.
 */
const whereSchema: z.ZodType<SheetWhereInput> = z.lazy(() =>
  z.union([
    conditionSchema,
    z.object({ and: z.array(whereSchema).min(1).max(64) }),
    z.object({ or: z.array(whereSchema).min(1).max(64) }),
    z.object({ not: whereSchema }),
  ]),
);

const orderBySchema = z.object({
  column: columnSchema,
  direction: z.enum(['asc', 'desc']).optional(),
  /**
   * Sort ONLY on the numeric value, placing every non-numeric cell last.
   * Rarely needed: the default already orders numbers numerically and text
   * lexicographically. Use it when text in a numeric column is a data problem
   * you want herded to the end rather than interleaved.
   */
  numeric: z.boolean().optional(),
});

/**
 * A stored cell. `raw` is what was authored, `value` what it evaluates to — a
 * formula cell carries both, which is why filtering and sorting can work on
 * results without re-evaluating anything.
 *
 * `format` is deliberately opaque. Its full shape (`CellFormat`) already exists
 * twice — in `@pagespace/db` and `@pagespace/lib` — kept in step by a
 * compile-time assertion those two share. The SDK cannot import either, so a
 * third hand-written copy would be the one with nothing keeping it honest, and
 * would start rejecting valid responses the first time a format key is added.
 * Callers that need formatting read it as data; callers that want rows are
 * unaffected.
 */
const storedCellSchema = z.object({
  raw: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
  type: z.enum(['empty', 'number', 'string', 'boolean']).optional(),
  format: z.record(z.string(), z.unknown()).optional(),
  error: z.object({
    type: z.string(),
    message: z.string().optional(),
    details: z.array(z.string()).optional(),
  }).optional(),
  notes: z.array(z.string()).optional(),
});

/** One spreadsheet row: its index, and the cells it actually has, by column letter. */
const rowSchema = z.object({
  rowIndex: z.number(),
  cells: z.record(z.string(), storedCellSchema),
});

const tabIndexSchema = z.number().int().min(0).optional();

/**
 * Filtered, sorted, paged rows — the read that makes a sheet usable as a
 * dataset. `total` counts every matching row, ignoring `limit`/`offset`, so a
 * caller can show "showing 20 of 4,312" without a second request.
 *
 * `rowIndex` always tie-breaks the sort server-side. Without it a filter with
 * ties returns a row twice and skips another as a caller pages, silently
 * corrupting a read-everything loop rather than failing it.
 */
export const queryRows = defineOperation({
  name: 'sheets.queryRows',
  method: 'POST',
  path: SHEETS_PATH,
  inputSchema: z.strictObject({
    operation: z.literal('query-rows').default('query-rows'),
    pageId: z.string(),
    tabIndex: tabIndexSchema,
    where: whereSchema.optional(),
    orderBy: z.array(orderBySchema).max(8).optional(),
    /** Column letters to return. Omitted means every column the row has. */
    select: z.array(columnSchema).max(64).optional(),
    limit: z.number().int().min(1).max(MAX_ROW_PAGE_SIZE).optional(),
    /** Rows to SKIP. Positional paging is `getRows`' `fromRow`, not this. */
    offset: z.number().int().min(0).optional(),
  }),
  outputSchema: z.object({
    pageId: z.string(),
    pageTitle: z.string().nullable(),
    tabIndex: z.number(),
    rows: z.array(rowSchema),
    total: z.number(),
    hasMore: z.boolean(),
  }),
  requiredScope: 'drive',
  description: 'Filter, sort and page the rows of a SHEET page. Filters match computed values, so formula columns compare as their results.',
});

/**
 * Rows by POSITION, for walking a sheet in order.
 *
 * `fromRow` is a row index, not a count of skipped rows, and the response says
 * where to continue via `nextFromRow`. That matters on a sparse tab (rows 0-9,
 * then 500-509): a caller advancing `offset += rows.length` would loop forever
 * on the same rows, while following `nextFromRow` terminates.
 */
export const getRows = defineOperation({
  name: 'sheets.getRows',
  method: 'POST',
  path: SHEETS_PATH,
  inputSchema: z.strictObject({
    operation: z.literal('get-rows').default('get-rows'),
    pageId: z.string(),
    tabIndex: tabIndexSchema,
    /** Row index to start at. Its page SIZE is `limit`. */
    fromRow: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(MAX_ROW_PAGE_SIZE).optional(),
  }),
  outputSchema: z.object({
    pageId: z.string(),
    pageTitle: z.string().nullable(),
    tabIndex: z.number(),
    rows: z.array(rowSchema),
    rowCount: z.number(),
    columnCount: z.number(),
    /** Where to continue from; `null` when the page came back empty. */
    nextFromRow: z.number().nullable(),
    hasMore: z.boolean(),
  }),
  requiredScope: 'drive',
  description: 'Read a SHEET page\'s rows by position, in order. Follow nextFromRow to page through sparse sheets safely.',
});

/**
 * A sheet's shape without any of its data — tabs, their names and extents.
 * The cheap first call for a caller that does not yet know what it is looking
 * at, or which `tabIndex` it wants.
 *
 * Takes NO `tabIndex`, unlike every other operation here. The branch lists
 * every tab and ignores the index entirely, but the route resolves
 * `getTab({pageId, tabIndex})` before dispatching, so passing an index that
 * does not exist 409s before `describe` ever runs. Accepting the field would
 * offer a parameter whose only possible effect is to make tab DISCOVERY fail
 * for exactly the caller who does not yet know which tabs exist.
 */
export const describeSheet = defineOperation({
  name: 'sheets.describe',
  method: 'POST',
  path: SHEETS_PATH,
  inputSchema: z.strictObject({
    operation: z.literal('describe').default('describe'),
    pageId: z.string(),
  }),
  outputSchema: z.object({
    pageId: z.string(),
    pageTitle: z.string().nullable(),
    tabs: z.array(z.object({
      tabIndex: z.number(),
      name: z.string(),
      rowCount: z.number(),
      columnCount: z.number(),
      frozenRows: z.number().nullable(),
    })),
  }),
  requiredScope: 'drive',
  description: 'List a SHEET page\'s tabs with their names and dimensions, without reading any rows.',
});

/**
 * Append rows to the end of a tab. Each entry maps column letter to cell text;
 * a value starting with `=` is stored as a formula and evaluated on write.
 *
 * `firstRowIndex` is where the batch landed, so a caller can address what it
 * just wrote without re-reading the sheet.
 */
export const appendRows = defineOperation({
  name: 'sheets.appendRows',
  method: 'POST',
  path: SHEETS_PATH,
  inputSchema: z.strictObject({
    operation: z.literal('append-rows').default('append-rows'),
    pageId: z.string(),
    tabIndex: tabIndexSchema,
    rows: z.array(z.record(columnSchema, z.string())).min(1).max(5_000),
  }),
  outputSchema: z.object({
    pageId: z.string(),
    pageTitle: z.string().nullable(),
    firstRowIndex: z.number(),
    appended: z.number(),
    rowCount: z.number(),
  }),
  requiredScope: 'drive',
  description: 'Append rows to a SHEET page. Each row maps column letters to cell text; values starting with "=" are formulas.',
});

/**
 * Write cells by A1 address and repair whatever depended on them.
 *
 * `recomputed` counts the formula cells re-evaluated because an input moved —
 * the transitive closure, and nothing else. It is the number that shows this is
 * not a whole-sheet recalculation: editing one cell of a 100,000-row sheet
 * recomputes the handful of formulas that actually read it.
 */
export const updateCells = defineOperation({
  name: 'sheets.updateCells',
  method: 'POST',
  path: SHEETS_PATH,
  inputSchema: z.strictObject({
    operation: z.literal('update-cells').default('update-cells'),
    pageId: z.string(),
    tabIndex: tabIndexSchema,
    cells: z.array(z.object({
      address: cellAddressSchema,
      value: z.string(),
    })).min(1).max(10_000),
  }),
  outputSchema: z.object({
    pageId: z.string(),
    pageTitle: z.string().nullable(),
    cellsUpdated: z.number(),
    recomputed: z.number(),
    rowCount: z.number(),
    columnCount: z.number(),
  }),
  requiredScope: 'drive',
  description: 'Write cells in a SHEET page by A1 address, recomputing only the formulas that depended on them.',
});

/**
 * Remove `count` rows starting at `fromRow`, shifting the rows below up.
 *
 * `count` is how many rows to delete — never a page size. The route rejects the
 * request outright if either is missing rather than guessing a default, because
 * a wrong guess here destroys data.
 */
export const deleteRows = defineOperation({
  name: 'sheets.deleteRows',
  method: 'POST',
  path: SHEETS_PATH,
  inputSchema: z.strictObject({
    operation: z.literal('delete-rows').default('delete-rows'),
    pageId: z.string(),
    tabIndex: tabIndexSchema,
    fromRow: z.number().int().min(0),
    count: z.number().int().min(1).max(100_000),
  }),
  outputSchema: z.object({
    pageId: z.string(),
    pageTitle: z.string().nullable(),
    deleted: z.number(),
    rowCount: z.number(),
  }),
  requiredScope: 'drive',
  /**
   * The only irreversible operation here: the rows are gone and everything
   * below them shifts up. Drives the MCP `destructiveHint` annotation, which is
   * how an agent frontend knows to ask before calling it — the CLI's own gate
   * is separate (`confirmDestructive` in the handler), since nothing reads this
   * flag outside the MCP layer.
   */
  destructive: true,
  description: 'Delete a contiguous range of rows from a SHEET page, shifting the rows below up.',
});
