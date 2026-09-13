/**
 * Sheet ROWS and sheet FORMATTING, over POST `/api/mcp/sheets`
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
 * The last two — `readFormatting` and `applyFormat` — are the presentation
 * layer rather than the data: regions, conditional rules, frozen panes, column
 * and cell formats. They exist because the in-process AI tools could already
 * format a sheet while an SDK or CLI caller could not, so a sheet built
 * programmatically stayed a grid of bare numbers.
 *
 * All eight are POST, so the client's idempotent-retry path already excludes
 * them (`isIdempotentMethod` is method-based) — no per-operation flag to thread.
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

// ---------------------------------------------------------------------------
// Formatting — how a sheet LOOKS
//
// Everything above treats a sheet as data. These two treat it as a document
// with a presentation, and they exist because the in-process AI tools
// (`format_sheet`, `set_conditional_format`, `read_sheet` with
// `includeFormatting`) could already do all of this while an SDK or CLI caller
// could do none of it — a sheet built programmatically was a grid of bare
// numbers with no call available to change that.
//
// The op union below is `SheetFormatOp` from `@pagespace/lib/sheets` verbatim,
// which makes these strictly MORE capable than the AI tools they bring parity
// with: a model can only add and remove conditional rules, while a
// programmatic caller can patch one in place, reorder it, or replace the list.
// The server validates every op through `planFormatOps` — pure, no I/O — and
// refuses the WHOLE request naming the offending op's index, so a batch never
// half-applies.
//
// Hand-written here rather than imported, for the reason `operations/roles.ts`
// and `operations/search.ts` state: the published SDK must never runtime- OR
// type-import `@pagespace/lib`, whose subpaths a consumer's `tsc` cannot
// resolve. `__tests__/sheets-format-drift-guard.test.ts` imports `OP_FIELDS`
// and the caps from lib — a devDependency, test-only — and asserts this union
// matches op for op and field for field, so a sixteenth op cannot join the
// union in lib without failing here.
// ---------------------------------------------------------------------------

/**
 * Caps mirrored from `@pagespace/lib/sheets`. Wire contract: the server
 * refuses anything past these regardless, and stating them in the schema means
 * a caller is refused locally, before a round trip.
 */
const MAX_FORMAT_OPS = 200;
const MAX_CONDITIONAL_RULES = 200;
const MAX_REGIONS = 50;
const MAX_REGION_COLUMNS = 256;
const MAX_REGION_TOTAL_ROWS = 64;
const MAX_REGION_HEADER_ROWS = 16;
const MIN_COLUMN_WIDTH = 24;
const MAX_COLUMN_WIDTH = 2_000;
const MIN_ROW_HEIGHT = 16;
const MAX_ROW_HEIGHT = 1_000;
const MAX_ADDRESSABLE_ROW = 5_000_000;
const MAX_ADDRESSABLE_COLUMN = 18_277; // ZZZ
const MAX_DECIMALS = 10;

/**
 * A format patch, deliberately opaque — the same decision, for the same
 * reason, as `storedCellSchema.format` above. `CellFormat` already exists twice
 * (`@pagespace/db`, `@pagespace/lib`) with a compile-time assertion holding
 * those two together, and the SDK can import neither; a third hand-written copy
 * would be the one with nothing keeping it honest, and would start refusing
 * valid requests the first time a format key is added.
 *
 * The server validates it field by field against `CELL_FORMAT_FIELDS` and
 * refuses an unknown key by name, so a typo is a 400 that says which key —
 * not a silently dropped field.
 *
 * Known fields: `number` ({kind, decimals, currency, thousands, dateStyle,
 * pattern}), `bold`, `italic`, `underline`, `strike`, `align`, `valign`,
 * `wrap`, `color`, `background`, `fontSize`, `fontFamily`, `borders`.
 */
const cellFormatSchema = z.record(z.string(), z.unknown());

/** A1 range — `"B2:D40"`, a single cell, or `"A1:F"` open to the sheet's end. */
const rangeSchema = z.string().min(1);

// On `columnSchema`, which the formatting ops below reuse: it allows up to
// seven letters, because that is what the ROW store's `assertColumn` allows and
// the query/projection operations above need. Formatting stops earlier — lib's
// `validateColumn` refuses anything past ZZZ — so `"ABCD"` clears this schema
// and is then refused by the server. Left deliberately: that refusal names the
// real boundary ("Column "ABCD" is past the last addressable column, ZZZ"),
// which beats the regex failure a tighter local schema would produce, and a
// local cap would start refusing valid columns the day the address space
// widens.

/**
 * A 1-based row number as `setRowHeight` takes it — row 417 is where `C417`
 * lives.
 *
 * The ceiling is `MAX_ADDRESSABLE_ROW + 1`, NOT `MAX_ADDRESSABLE_ROW`, because
 * that constant bounds a 0-BASED index: `decodeCellAddress` returns
 * `parseInt(rowPart) - 1`. lib bounds this field as `row - 1 >
 * MAX_ADDRESSABLE_ROW`, and its comment records the bug that produced that
 * form — comparing `row` to the constant directly "left the last addressable
 * row able to take a cell format but not a row height, which is the kind of
 * disagreement no caller can see coming". Capping at the constant here would
 * reintroduce exactly that, one layer up, as a local refusal of a row the
 * server accepts.
 */
const rowHeightRowSchema = z.number().int().min(1).max(MAX_ADDRESSABLE_ROW + 1);

/**
 * A 1-based row number as a REGION's `totalRows` takes it — a different
 * ceiling from `rowHeightRowSchema`, deliberately, and not a copy-paste slip.
 * lib's `readTotalRows` filters on `row >= 1 && row <= MAX_ADDRESSABLE_ROW`,
 * comparing the 1-based value to the constant without the shift, so the last
 * row a height can be set on is one past the last row that can be marked a
 * total. Mirroring lib field by field is the only way these agree; a single
 * shared "row number" schema would have to be wrong for one of them.
 */
const totalRowSchema = z.number().int().min(1).max(MAX_ADDRESSABLE_ROW);

/**
 * A frozen-pane COUNT, not an index. `0` unfreezes that axis; `null` clears it.
 *
 * The real bound is the tab's own extent — the server refuses "freeze 5 rows"
 * on a 3-row sheet, naming both numbers — so these ceilings only keep an absurd
 * value from reaching it at all. `+ 1` because a count of every addressable
 * row is one more than the largest 0-based index those constants hold.
 */
const frozenRowCountSchema = z.number().int().min(0).max(MAX_ADDRESSABLE_ROW + 1);
const frozenColumnCountSchema = z.number().int().min(0).max(MAX_ADDRESSABLE_COLUMN + 1);

/**
 * Fields that belong to SOME rule kind, and so may be foreign to another —
 * lib's `KIND_FIELDS`, which is `FIELDS_BY_KIND` flattened.
 *
 * The rule schemas below are LOOSE, because lib's `parseConditionalRule` and
 * `parseRegion` spread the stored value (`{...value, id, kind, ...}`) and
 * deliberately carry unknown fields through untouched: "a rule written by a
 * newer build survives a load/save cycle here". A strict schema would reject
 * the whole `readFormatting` response the first time a newer same-major server
 * returned a rule carrying an extension field, and would then refuse to write
 * that rule back — breaking the read-modify-write round trip these two
 * operations exist to support.
 *
 * Cross-kind fields stay refused, because those are not extensions: lib's
 * `ruleRenderProblem` refuses them too, on exactly this list, since "a
 * `${kind}` rule does not read ${field}, so it would be stored and never
 * used". Accepting one silently would store half a caller's instruction and
 * report success.
 */
const FIELDS_BY_KIND = {
  cell: ['condition', 'format'],
  formula: ['formula', 'format'],
  colorScale: ['min', 'mid', 'max'],
  dataBar: ['color', 'min', 'max'],
} as const satisfies Record<string, readonly string[]>;

const KIND_FIELDS = [...new Set(Object.values(FIELDS_BY_KIND).flat())];

/**
 * Refuses only the fields that belong to a DIFFERENT kind, leaving genuinely
 * unknown ones alone. Mirrors `ruleRenderProblem`'s loop, including reading
 * what the caller sent rather than a merged rule.
 */
const noForeignKindFields = (kind: string, own: readonly string[]) =>
  (rule: Record<string, unknown>, ctx: z.RefinementCtx): void => {
    for (const field of KIND_FIELDS) {
      if (rule[field] === undefined || own.includes(field)) continue;
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `A ${kind} rule does not read ${field}, so it would be stored and never used.`,
      });
    }
  };

/**
 * Strict, unlike the rule and region schemas above it. `readAnchor` builds a
 * FRESH object rather than spreading, so an extension field on an anchor is
 * dropped server-side and never comes back in a response — accepting one here
 * would promise a round trip that does not happen.
 */
const scaleAnchorSchema = z.strictObject({
  type: z.enum(['min', 'max', 'number', 'percent', 'percentile']),
  /** Required for `number`, `percent` and `percentile`. */
  value: z.number().optional(),
  /** `#rrggbb`. Required on a colour scale's `min`/`max`; unused by a data bar's bounds. */
  color: z.string().optional(),
});

/**
 * A stored conditional rule. Note `condition`, not the flat
 * `operator`/`value`/`value2` the AI tool takes: that flattening exists because
 * a discriminated union fans out to `anyOf` past the schema-size ceiling a
 * model's tool definition can carry. A programmatic caller has no such limit,
 * so this is the shape the sheet actually stores.
 *
 * `id` is REQUIRED and supplied by the caller, unlike the AI tool where it is
 * minted. That is the better contract here: the id is the caller's own
 * idempotency key, so retrying `addConditionalRule` after a timeout is refused
 * as a duplicate rather than silently adding the rule a second time.
 */
const conditionalRuleSchema = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('cell'),
    id: z.string().min(1),
    ranges: z.array(rangeSchema).min(1),
    // STRICT, like `scaleAnchorSchema` and unlike everything else in this
    // rule, because lib REBUILDS this object rather than spreading it:
    // `parseConditionalRule` constructs `{operator}` and copies only `value`
    // and `value2` onto it. So an extension inside `condition` can never come
    // back from a read, and on a write lib refuses it by name —
    // `firstSanitizedPath` walks the REQUEST's keys and reports the first one
    // that would not survive, as `condition.<field>`. Accepting one here would
    // promise a round trip that does not happen, and cost a round trip to be
    // told the same thing the schema already knows.
    condition: z.strictObject({
      operator: z.enum([
        'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual',
        'equal', 'notEqual', 'between', 'notBetween',
        'contains', 'notContains', 'startsWith', 'endsWith',
        'isEmpty', 'isNotEmpty', 'isError',
      ]),
      /** The operand, as TEXT — a status name and a threshold share this field. Omitted for isEmpty/isNotEmpty/isError. */
      value: z.string().optional(),
      /** Upper bound, for `between`/`notBetween`. */
      value2: z.string().optional(),
    }),
    format: cellFormatSchema,
  }).superRefine(noForeignKindFields('cell', FIELDS_BY_KIND.cell)),
  z.looseObject({
    kind: z.literal('formula'),
    id: z.string().min(1),
    ranges: z.array(rangeSchema).min(1),
    /** Evaluated per cell, relative references shifted from the range's top-left, as a paste would. */
    formula: z.string().min(1),
    format: cellFormatSchema,
  }).superRefine(noForeignKindFields('formula', FIELDS_BY_KIND.formula)),
  z.looseObject({
    kind: z.literal('colorScale'),
    id: z.string().min(1),
    ranges: z.array(rangeSchema).min(1),
    min: scaleAnchorSchema,
    mid: scaleAnchorSchema.optional(),
    max: scaleAnchorSchema,
  }).superRefine(noForeignKindFields('colorScale', FIELDS_BY_KIND.colorScale)),
  z.looseObject({
    kind: z.literal('dataBar'),
    id: z.string().min(1),
    ranges: z.array(rangeSchema).min(1),
    /** The bar colour, `#rrggbb`. */
    color: z.string(),
    min: scaleAnchorSchema.optional(),
    max: scaleAnchorSchema.optional(),
  }).superRefine(noForeignKindFields('dataBar', FIELDS_BY_KIND.dataBar)),
]);

export type SheetConditionalRuleInput = z.infer<typeof conditionalRuleSchema>;

/**
 * A declared table. A region says what an area IS — "A1:F is a table, row 1 is
 * its header, column C is money, row 40 is a total" — and the presentation is
 * DERIVED from it at render time.
 *
 * Prefer it over per-cell ops for anything table-shaped, for two reasons that
 * are not cosmetic: an open range (`"A1:F"`, no row end) covers rows that do
 * not exist yet, so a row appended next week inherits the format with no second
 * pass; and it costs no cell budget however tall the sheet is, where
 * `setCellFormat` over `A2:A5000` charges 4,999 cells.
 *
 * No `freezeHeader` — frozen panes are tab state, not derived presentation.
 * Send a `setFrozen` op alongside.
 */
const regionSchema = z.looseObject({
  id: z.string().min(1),
  /** Shown to people and to agents reading the sheet back; never rendered into it. */
  name: z.string().optional(),
  range: rangeSchema,
  /** Leading rows that are headers rather than data. Defaults to 1. */
  headerRows: z.number().int().min(0).max(MAX_REGION_HEADER_ROWS).optional(),
  /** Absolute 1-based row numbers holding totals. */
  totalRows: z.array(totalRowSchema).max(MAX_REGION_TOTAL_ROWS).optional(),
  // Loose for the same reason the region itself is: `readColumns` spreads the
  // stored entry, so an extension field on a column travels through untouched
  // and must survive a round trip rather than fail the read.
  columns: z.array(z.looseObject({
    column: columnSchema,
    /** A MEANING, not a format: which number format renders `currency` is the sheet's decision. */
    role: z.enum(['text', 'number', 'currency', 'percent', 'date', 'datetime', 'id']),
    /** ISO 4217, for `role: 'currency'`. */
    currency: z.string().length(3).optional(),
    /** Overrides the role's default precision. */
    decimals: z.number().int().min(0).max(MAX_DECIMALS).optional(),
  })).max(MAX_REGION_COLUMNS).optional(),
  /**
   * A hue name from the sheet's shared palette: `slate`, `blue`, `cyan`,
   * `teal`, `green`, `amber`, `orange`, `red`, `pink`, `purple`, `violet`,
   * `indigo`.
   *
   * Named here rather than enumerated in the schema, for the same reason
   * `columnSchema` stays wide: an enum would refuse a hue a newer build adds,
   * while the server already refuses an unknown one by name ("... is not a hue
   * this build has, and would render as ..."), which is the more useful error.
   */
  theme: z.string().optional(),
});

export type SheetRegionInput = z.infer<typeof regionSchema>;

/**
 * One formatting edit. `SheetFormatOp` in `@pagespace/lib/sheets` verbatim.
 *
 * ORDER MATTERS and is preserved: a `clearCellFormat` after a `setCellFormat`
 * over the same cells means something different from the reverse, and the
 * server applies the list as given, in ONE transaction.
 *
 * `null` means "clear this" on the ops that accept it. An OMITTED axis on
 * `setFrozen` keeps whatever the tab holds at plan time — under the server's
 * lock — so "freeze one row" never has to restate a column freeze the caller
 * read a moment ago and cannot know still stands.
 */
const formatOpSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('setCellFormat'), range: rangeSchema, patch: cellFormatSchema }),
  z.strictObject({ type: z.literal('clearCellFormat'), range: rangeSchema }),
  z.strictObject({ type: z.literal('setColumnFormat'), column: columnSchema, patch: cellFormatSchema }),
  z.strictObject({
    type: z.literal('setColumnWidth'),
    column: columnSchema,
    /** Pixels. `null` restores the default width. */
    width: z.number().int().min(MIN_COLUMN_WIDTH).max(MAX_COLUMN_WIDTH).nullable(),
  }),
  z.strictObject({
    type: z.literal('setRowHeight'),
    row: rowHeightRowSchema,
    /** Pixels. `null` restores the default height. */
    height: z.number().int().min(MIN_ROW_HEIGHT).max(MAX_ROW_HEIGHT).nullable(),
  }),
  z.strictObject({
    type: z.literal('setFrozen'),
    rows: frozenRowCountSchema.nullable().optional(),
    columns: frozenColumnCountSchema.nullable().optional(),
  }).refine(
    (op) => op.rows !== undefined || op.columns !== undefined,
    // Both omitted is not "freeze nothing", it is a request that names no
    // axis: the server refuses it, and refusing it here saves the round trip.
    { message: 'setFrozen needs "rows" and/or "columns" (a count, or null to clear).' },
  ),
  z.strictObject({ type: z.literal('addConditionalRule'), rule: conditionalRuleSchema }),
  z.strictObject({
    type: z.literal('updateConditionalRule'),
    id: z.string().min(1),
    /** Fields of the rule to merge. Its `kind` cannot be changed. */
    patch: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({ type: z.literal('removeConditionalRule'), id: z.string().min(1) }),
  z.strictObject({
    type: z.literal('moveConditionalRule'),
    id: z.string().min(1),
    /** `1` later in the list (wins over earlier rules), `-1` earlier. */
    direction: z.union([z.literal(-1), z.literal(1)]),
  }),
  z.strictObject({ type: z.literal('clearConditionalRules') }),
  /** The FINAL list, in this order. A rule the tab holds and this list omits is removed. */
  z.strictObject({ type: z.literal('setConditionalRules'), rules: z.array(conditionalRuleSchema).max(MAX_CONDITIONAL_RULES) }),
  /** The FINAL list. An empty array clears every declared region. */
  z.strictObject({ type: z.literal('setRegions'), regions: z.array(regionSchema).max(MAX_REGIONS) }),
  z.strictObject({ type: z.literal('upsertRegion'), region: regionSchema }),
  z.strictObject({ type: z.literal('removeRegion'), id: z.string().min(1) }),
]);

export type SheetFormatOpInput = z.infer<typeof formatOpSchema>;

/**
 * How a tab is styled, in one read — the programmatic equivalent of
 * `read_sheet`'s `includeFormatting`.
 *
 * `ranges` is the one part that costs anything: per-cell formats live on the
 * rows, so they are read only for the rectangles asked for. Omit it and the
 * declarative layer (regions, conditional rules, column defaults, freezes)
 * comes back for free — which is the layer a caller about to WRITE formatting
 * needs, so it can build on what is there instead of over it.
 *
 * Rules and regions come back PARSED, so they can be written straight back
 * through `applyFormat`; a caller that round-tripped the raw stored jsonb
 * would resurrect entries the parser drops on every load.
 *
 * `cellFormats` is EXPLICIT per-cell formatting only. The format actually in
 * force for a cell also depends on its column default and its region, and
 * resolving that precedence has exactly one definition (server-side) — a
 * second one here is how a grid and an export come to disagree.
 */
export const readSheetFormatting = defineOperation({
  name: 'sheets.readFormatting',
  method: 'POST',
  path: SHEETS_PATH,
  inputSchema: z.strictObject({
    operation: z.literal('read-formatting').default('read-formatting'),
    pageId: z.string(),
    tabIndex: tabIndexSchema,
    /** A1 rectangles whose per-cell formats to return. Omitted, none are read. */
    ranges: z.array(rangeSchema).max(MAX_FORMAT_OPS).optional(),
  }),
  outputSchema: z.object({
    pageId: z.string(),
    pageTitle: z.string().nullable(),
    tabIndex: z.number(),
    rowCount: z.number(),
    columnCount: z.number(),
    frozenRows: z.number().nullable(),
    frozenColumns: z.number().nullable(),
    /** Column defaults, by column letters. */
    columnFormats: z.record(z.string(), cellFormatSchema),
    /** Pixels, by column letters. */
    columnWidths: z.record(z.string(), z.number()),
    /** Pixels, by 1-based row number as a string, as stored. */
    rowHeights: z.record(z.string(), z.number()),
    conditionalFormats: z.array(conditionalRuleSchema),
    regions: z.array(regionSchema),
    /** Explicit per-cell formats inside `ranges`, by A1 address. */
    cellFormats: z.record(z.string(), cellFormatSchema),
  }),
  requiredScope: 'drive',
  description: 'Read how a SHEET page is STYLED: declared regions, conditional rules, frozen panes, column formats and widths, row heights, and per-cell formats within the ranges asked for. Call it before writing formatting, to build on what is there.',
});

/**
 * Apply an ordered list of formatting ops, all or nothing.
 *
 * Every op is validated before anything is written — against the tab's state,
 * so a range past the sheet or a rule id that does not exist is refused — and
 * the refusal names the op's INDEX in the list sent. A request refused for any
 * reason writes nothing: the ops are order-dependent, so a partial apply would
 * leave a half-styled sheet whose state the caller cannot infer from the error.
 *
 * NOT flagged destructive, though `setRegions: []` and `clearConditionalRules`
 * do discard declared structure. The flag makes the CLI demand `--yes` on
 * every call, and gating "bold the header row" behind a confirmation prompt
 * buys nothing: formatting is presentation, recoverable by writing it again,
 * unlike `deleteRows`, which destroys data.
 *
 * `changed` is false when the sheet already looked like this — a retry, a bold
 * that was already bold. Nothing was written and no revision bumped, so a
 * caller must not report it as a change.
 */
export const applySheetFormat = defineOperation({
  name: 'sheets.applyFormat',
  method: 'POST',
  path: SHEETS_PATH,
  inputSchema: z.strictObject({
    operation: z.literal('apply-format').default('apply-format'),
    pageId: z.string(),
    tabIndex: tabIndexSchema,
    ops: z.array(formatOpSchema).min(1).max(MAX_FORMAT_OPS),
  }),
  outputSchema: z.object({
    pageId: z.string(),
    pageTitle: z.string().nullable(),
    tabIndex: z.number(),
    /** Whether anything was actually written. False for a no-op retry. */
    changed: z.boolean(),
    /** Cells whose stored `format` changed. */
    cellsFormatted: z.number(),
    /** Stored rows this call wrote — the number that shows the write was O(touched), not O(sheet). */
    rowsTouched: z.number(),
    /** Tab-level columns whose stored value changed, by name. */
    tabFieldsChanged: z.array(z.string()),
    /**
     * How many conditional rules the tab holds AFTER the write — a COUNT, not
     * the rules. `readFormatting` is the call that returns them, under
     * `conditionalFormats`.
     */
    conditionalRules: z.number(),
    /** What the write actually added and removed, computed under the lock — not from any caller's earlier read. */
    ruleIdsAdded: z.array(z.string()),
    ruleIdsRemoved: z.array(z.string()),
    /**
     * How many regions the tab holds AFTER the write — a COUNT, where
     * `readFormatting.regions` is an ARRAY of them. The asymmetry is lib's
     * (`ApplyFormatOpsResult.regions` is a number, `TabFormatting.regions` a
     * list) and the route spreads both verbatim, so renaming either here would
     * put the SDK out of step with what the server actually sends.
     */
    regions: z.number(),
    regionIdsAdded: z.array(z.string()),
    regionIdsRemoved: z.array(z.string()),
    rowCount: z.number(),
    columnCount: z.number(),
    /** Formulas re-evaluated because the sheet's extent grew. Empty for every other format write. */
    recomputed: z.array(z.string()),
  }),
  requiredScope: 'drive',
  description: 'Apply formatting to a SHEET page: declare regions (tables, header rows, column roles, totals), set cell/column formats, column widths, row heights, frozen panes, and conditional formatting rules. Ops apply in order, in one transaction, all or nothing. Prefer a region for anything table-shaped — it covers rows added later and costs no cell budget.',
});
