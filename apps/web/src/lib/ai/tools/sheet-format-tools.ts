/**
 * `format_sheet` and `set_conditional_format` — how an agent makes a sheet
 * presentable.
 *
 * Until these existed the only sheet write an agent had was `edit_sheet_cells`,
 * which takes `{address, value}` and nothing else. Asked for a budget dashboard
 * it produced a grid of bare numbers, and there was no call it could make to
 * change that. The presentation model was all there — per-cell formats, column
 * defaults, freezes, conditional rules, and since the region model landed,
 * declared table structure — with only browser callers.
 *
 * Both tools are thin facades over `applyFormatOps` in
 * `@pagespace/lib/sheets/store`, which does the whole write in ONE transaction
 * and refuses, through `planFormatOps`, everything the toolbar's own setters
 * would quietly clamp or drop. This module adds the layer a model needs on top
 * of that and nothing the store already does:
 *
 *  - **A schema shaped for how an agent formats.** A person formats
 *    iteratively — click bold, look, adjust. An agent formats blind and once.
 *    So `format_sheet` puts `regions` FIRST and describes it as the normal
 *    path: an agent declares that `A1:F` is a table with a header row, that C
 *    is money and row 40 is a total, and `region-format` derives the
 *    presentation at evaluation time. A region covers rows that do not exist
 *    yet, so the row an agent appends next week inherits the format; it costs
 *    nothing however tall the sheet is, so a model that read fifty rows of a
 *    five-thousand-row sheet cannot format only the fifty it saw; and it never
 *    hands the model a colour picker, so the result reads as PageSpace rather
 *    than as something garish. The per-cell `ops` are the escape hatch, and
 *    the description says so.
 *
 *  - **Flat op objects, not a discriminated union.** `sheet-read-tools.ts`
 *    records why: a `$ref`/recursive schema is rejected outright by several
 *    providers, and a union of six object shapes fans out to `anyOf` with six
 *    copies of the shared format sub-schema, past the `MAX_SCHEMA_CHARS`
 *    ceiling the parameter-error path can inline. The consequence is that zod
 *    can only check what is independently true of one field, and every
 *    cross-field rule — `columnWidth` needs `width`, `freeze` takes no `range`,
 *    `between` needs `value2` — is checked in `execute`, before any I/O, and
 *    refused naming the op index and the field. Not `.superRefine()`: an
 *    object-level check does not run when the shape parse fails, and a
 *    field-level issue cannot see its siblings.
 *
 *  - **Caps the model can see.** Op and region and rule counts are in the zod
 *    schema, so they render into the JSON Schema and a model chunks before it
 *    is refused. Cell budgets are per op and per call, counted from the range's
 *    corners BEFORE anything is expanded, so `A1:Z100000` is refused from
 *    arithmetic rather than from an allocation. Every over-budget refusal
 *    names the construct that costs nothing — a `columnFormat` op for a whole
 *    column, a region for a table — because a model that is only told "too
 *    many cells" chunks into ten calls instead of switching.
 *
 *  - **All-or-nothing, with a spy-able guarantee.** Ops are order-dependent
 *    by design, so a partial apply leaves a half-styled sheet whose state the
 *    agent cannot infer from the error. Everything is validated first, then the
 *    whole ordered list goes to `applyFormatOps` in one call. A request that is
 *    refused for any reason — this module's checks or the store's planner —
 *    reaches the mutator zero times.
 *
 *  - **Retry idempotency for rules.** Rule ids are minted here, not supplied
 *    by the model (it only ever needs one to remove a rule, and `read_sheet`
 *    hands those back). Minting means a retried `set_conditional_format` would
 *    add every rule a second time under fresh ids — and retries after a
 *    timeout are routine. Identical rules are therefore deduplicated by content
 *    on append, and the response says which were already there.
 *
 * A NEW module rather than an addition to `sheet-read-tools.ts` or
 * `sheet-view.ts`, because both are pinned read-only by
 * `sheet-read-is-read-only.guard.test.ts` against every mutating store export,
 * and this one imports the write path on purpose.
 *
 * Not registered anywhere yet: wiring into `ai-tools.ts`, `WRITE_TOOLS`,
 * `tool-labels.ts` and the sheet skill is a separate change.
 */
import { randomUUID } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { PageType } from '@pagespace/lib/utils/enums';
import {
  MAX_ADDRESSABLE_ROW,
  MAX_CONDITIONAL_RULES,
  MAX_DECIMALS,
  MAX_COLUMN_WIDTH,
  MAX_FONT_SIZE,
  MAX_REGION_HEADER_ROWS,
  MAX_ROW_HEIGHT,
  MIN_COLUMN_WIDTH,
  MIN_FONT_SIZE,
  MIN_ROW_HEIGHT,
  PALETTE,
  RANGE_OPERATORS,
  SheetFormatError,
  VALUELESS_OPERATORS,
  isSheetType,
  normalizeHex,
  parseRangeSpan,
  parseRegionRange,
  planFormatOps,
  type CellFormat,
  type ConditionalOperator,
  type ConditionalRule,
  type RegionColumn,
  type ScaleAnchor,
  type SheetFormatOp,
  type SheetRegion,
} from '@pagespace/lib/sheets/sheet';
import {
  applyFormatOps,
  ensureTab,
  listTabs,
  readTabFormatting,
  type TabFormatting,
  type TabRef,
} from '@pagespace/lib/sheets/store';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { maskIdentifier } from '@/lib/logging/mask';
import { logSheetCellActivity } from '@/services/api/sheet-activity';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import type { ToolExecutionContext } from '../core/types';
import { canActorEditPage } from './actor-permissions';
import { resolveOrThrowPageId } from './page-context-defaults';
import { buildAiMutationContext } from './page-write-tools';
import {
  SheetDocumentUnreadableError,
  loadSheetWindow,
  toTabSummaries,
  type SheetTabSummary,
} from './sheet-view';

const sheetFormatLogger = loggers.ai.child({ module: 'sheet-format-tools' });

// ---------------------------------------------------------------------------
// Caps
//
// Ops are the unit a model reasons in; cells are the physical bound
// underneath. The op, region and rule caps live in the zod schema so they
// render into the JSON Schema and the model chunks before it is refused. The
// cell caps cannot — they are a function of a range's corners, which zod
// cannot see across fields — so they are enforced in `execute` and stated in
// the tool description instead.
//
// Both cell caps sit well under the store's own (`MAX_FORMAT_CELLS` 50,000 per
// op, 200,000 per request). The store's bound is what keeps a request from
// hurting the database; this one is what keeps a model from formatting a
// table cell-by-cell when a region would cover it for free. A request that
// clears this one always clears the store's.
// ---------------------------------------------------------------------------

/** The most escape-hatch ops one call may carry. */
export const MAX_FORMAT_OPS_PER_CALL = 100;
/** The most cells one range op may address, counted from its corners. */
export const MAX_FORMAT_RANGE_CELLS = 20_000;
/** The most cells one call may address across all of its range ops. */
export const MAX_FORMAT_CELLS_PER_CALL = 50_000;
/** The most regions one call may declare. */
export const MAX_REGIONS_PER_CALL = 20;
/** The most conditional rules one call may add. */
export const MAX_RULES_PER_CALL = 20;

/**
 * The line every over-budget refusal AND the tool description carry. Without
 * it a model that hits the cap chunks `A2:A5000` into ten calls of five
 * hundred rows; with it, it switches to the construct that costs nothing.
 */
const CHEAPER_CONSTRUCTS =
  'A whole column costs one columnFormat op and no cell budget; A2:A5000 costs 4,999 cells — and a ' +
  'region costs nothing at all, however tall the sheet is.';

const HUE_NAMES = PALETTE.map((hue) => hue.name) as [string, ...string[]];

/** Past any workbook; bounds the schema's `tabIndex` so it renders a real maximum. */
const MAX_TABS = 1_000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * The format a model may write: `CellFormat` narrowed in two places.
 *
 *  - No `borders`. It is the largest single contributor to the serialised
 *    schema (four sides of `{style, color}`, about 600 characters of JSON
 *    Schema) and the least useful to an agent — a fill carries table structure
 *    better, and the region model applies its own borders where they belong.
 *  - No number `kind: 'custom'` and no `pattern`. `applyNumberFormat` returns
 *    null for `custom`, so an agent that set one would get a format that
 *    renders nothing; the kind exists to round-trip imported patterns, not to
 *    be authored.
 *
 * Colours are `z.string()` rather than the `#rrggbb` regex `cellFormatSchema`
 * uses, because a model WILL write `#fff`, and refusing that is a round trip
 * for nothing. `normalizeHex` widens it to `#ffffff` in `toCellFormat` before
 * the store sees it; anything that is not a colour is refused there by name.
 *
 * `.strict()` so a misspelled field (`bolt`) is a parameter error the model
 * sees, rather than a key zod strips in silence on the way in.
 */
const aiNumberFormatSchema = z
  .object({
    kind: z.enum(['auto', 'plain', 'number', 'currency', 'percent', 'date', 'time', 'datetime', 'scientific', 'text']),
    decimals: z.number().int().min(0).max(MAX_DECIMALS).optional(),
    currency: z.string().length(3).optional().describe('ISO 4217.'),
    thousands: z.boolean().optional(),
    dateStyle: z.enum(['short', 'medium', 'long', 'iso']).optional(),
  })
  .strict();

const aiCellFormatSchema = z
  .object({
    number: aiNumberFormatSchema.optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    valign: z.enum(['top', 'middle', 'bottom']).optional(),
    wrap: z.boolean().optional(),
    color: z.string().optional().describe('#rrggbb'),
    background: z.string().optional().describe('#rrggbb'),
    fontSize: z.number().int().min(MIN_FONT_SIZE).max(MAX_FONT_SIZE).optional(),
    fontFamily: z.enum(['sans', 'mono']).optional(),
  })
  .strict();

type AiCellFormat = z.infer<typeof aiCellFormatSchema>;

const columnSchema = z.string().regex(/^[A-Za-z]{1,7}$/, 'Column must be letters, e.g. "A" or "AB"');

const rangeSchema = z.string().describe('A1 range, e.g. "B2:D40".');

/**
 * Bounded explicitly, because `z.number().int()` alone renders
 * `"maximum":9007199254740991` into the JSON Schema — thirty characters of
 * nothing, five times over, against a 4,000-character ceiling.
 */
const rowNumberSchema = z.number().int().min(1).max(MAX_ADDRESSABLE_ROW + 1);
const countSchema = z.number().int().min(0).max(MAX_ADDRESSABLE_ROW + 1);

const COLUMN_ROLES = ['text', 'number', 'currency', 'percent', 'date', 'datetime', 'id'] as const;

const regionColumnSchema = z
  .object({
    column: columnSchema,
    role: z.enum(COLUMN_ROLES),
    currency: z.string().length(3).optional(),
    decimals: z.number().int().min(0).max(MAX_DECIMALS).optional(),
  })
  .strict();

/**
 * Mirrors `SheetRegion`. `id` is optional here and minted when absent — a
 * model declaring a table for the first time has no id to give, and a model
 * restyling one it read back does.
 */
const regionSchema = z
  .object({
    id: z.string().min(1).optional().describe('Omit for a new region.'),
    name: z.string().optional(),
    range: z.string().describe('"A1:F40", or "A1:F" to the end of the sheet.'),
    headerRows: z.number().int().min(0).max(MAX_REGION_HEADER_ROWS).optional().describe('Default 1.'),
    totalRows: z.array(rowNumberSchema).max(64).optional().describe('1-based total rows.'),
    columns: z.array(regionColumnSchema).max(64).optional(),
    theme: z.enum(HUE_NAMES).optional().describe('Accent hue.'),
    freezeHeader: z.boolean().optional().describe('Pin the header rows (region must start at row 1).'),
  })
  .strict();

type RegionInput = z.infer<typeof regionSchema>;

const FORMAT_OPS = ['setFormat', 'clearFormat', 'columnFormat', 'columnWidth', 'rowHeight', 'freeze'] as const;
type FormatOpName = (typeof FORMAT_OPS)[number];

/**
 * One escape-hatch op, flat. Which fields each `op` reads is stated once, on
 * the `op` enum, and enforced by `OP_TAKES` in `execute`. Stated there rather
 * than per field because this object is inlined into the JSON Schema and every
 * character counts against `MAX_SCHEMA_CHARS`; a hint per field cost twice as
 * much for the same information.
 */
const formatOpSchema = z
  .object({
    op: z
      .enum(FORMAT_OPS)
      .describe(
        'setFormat: range+format. clearFormat: range. columnFormat: column+format. columnWidth: ' +
        'column+width|clear. rowHeight: row+height|clear. freeze: frozenRows/frozenColumns|clear.'
      ),
    range: z.string().optional(),
    column: columnSchema.optional(),
    row: rowNumberSchema.optional().describe('1-based.'),
    format: aiCellFormatSchema.optional(),
    width: z.number().int().min(MIN_COLUMN_WIDTH).max(MAX_COLUMN_WIDTH).optional().describe('px'),
    height: z.number().int().min(MIN_ROW_HEIGHT).max(MAX_ROW_HEIGHT).optional().describe('px'),
    frozenRows: countSchema.optional(),
    frozenColumns: countSchema.optional(),
    clear: z.literal(true).optional(),
  })
  .strict();

type FormatOpInput = z.infer<typeof formatOpSchema>;

const formatSheetInputSchema = z.object({
  pageId: z.string().optional().describe('Defaults to the page in view.'),
  tabIndex: z.number().int().min(0).max(MAX_TABS).optional(),
  regions: z
    .array(regionSchema)
    .max(MAX_REGIONS_PER_CALL)
    .optional()
    .describe(
      "Declare a table's structure — header rows, column roles, total rows, theme — and its presentation " +
      'is derived. This is how you format a table; a region covers rows added later.'
    ),
  regionMode: z
    .enum(['merge', 'replaceAll'])
    .optional()
    .describe('merge (default) upserts by id; replaceAll keeps only these.'),
  ops: z
    .array(formatOpSchema)
    .max(MAX_FORMAT_OPS_PER_CALL)
    .optional()
    .describe(
      'Escape hatch for what a region cannot express — one emphasised cell, a column width. Prefer ' +
      'regions: a range op does NOT cover rows added later.'
    ),
});

type FormatSheetInput = z.infer<typeof formatSheetInputSchema>;

const OPERATORS = [
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
  'equal',
  'notEqual',
  'between',
  'notBetween',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'isEmpty',
  'isNotEmpty',
  'isError',
] as const satisfies readonly ConditionalOperator[];

const anchorSchema = z
  .object({
    type: z.enum(['min', 'max', 'number', 'percent', 'percentile']),
    value: z.number().optional().describe('For number/percent/percentile.'),
    color: z.string().optional().describe('#rrggbb; colorScale only.'),
  })
  .strict();

/**
 * A `value` on the wire is text, because a status name and a date share the
 * field with a number. A model writes `value: 5` anyway, and the store is
 * right to refuse that at the API — storing "5" for 5 would be it writing
 * something other than what was asked. Here the asker is a model and the
 * number is exactly what it meant, so it is accepted and stringified.
 */
const operandSchema = z.union([z.string(), z.number()]);

/**
 * One rule, flat: the four kinds share one object and `kind` decides which
 * fields are read. Cross-kind fields are refused in `execute`, not stripped.
 * `id` is deliberately NOT here — see the module doc on retries.
 */
const ruleSchema = z
  .object({
    kind: z.enum(['cell', 'formula', 'colorScale', 'dataBar']),
    ranges: z.array(rangeSchema).min(1).max(64).describe('Ranges the rule covers.'),
    operator: z.enum(OPERATORS).optional().describe('cell.'),
    value: operandSchema.optional().describe('cell: the operand. Not for isEmpty/isNotEmpty/isError.'),
    value2: operandSchema.optional().describe('cell: upper bound for between/notBetween.'),
    formula: z.string().max(4000).optional().describe('formula: e.g. "=C2>AVERAGE(C:C)", anchored at the range\'s top-left.'),
    format: aiCellFormatSchema.optional().describe('cell/formula: applied where the rule matches.'),
    min: anchorSchema.optional().describe('colorScale (needs color) / dataBar.'),
    mid: anchorSchema.optional().describe('colorScale.'),
    max: anchorSchema.optional().describe('colorScale (needs color) / dataBar.'),
    color: z.string().optional().describe('dataBar: bar colour, #rrggbb.'),
  })
  .strict();

type RuleInput = z.infer<typeof ruleSchema>;

const setConditionalFormatInputSchema = z.object({
  pageId: z.string().optional().describe('Defaults to the page in view.'),
  tabIndex: z.number().int().min(0).max(MAX_TABS).optional().describe('Default 0.'),
  mode: z
    .enum(['append', 'replaceAll'])
    .optional()
    .describe('append (default) adds to the existing rules; replaceAll keeps only these.'),
  rules: z.array(ruleSchema).max(MAX_RULES_PER_CALL).optional(),
  removeRuleIds: z
    .array(z.string().min(1))
    .max(MAX_CONDITIONAL_RULES)
    .optional()
    .describe('Ids to remove (from read_sheet with includeFormatting). append mode only.'),
});

type SetConditionalFormatInput = z.infer<typeof setConditionalFormatInputSchema>;

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * The established envelope — RETURNED, not thrown, so the model reads it as a
 * correction rather than as a crashed tool. Every refusal that is about the
 * request names the op, region or rule index, because a batch refusal without
 * one is not actionable.
 */
interface Refusal {
  success: false;
  error: string;
  message: string;
  suggestion: string;
  [extra: string]: unknown;
}

const refusal = (error: string, message: string, suggestion: string, extra: Record<string, unknown> = {}): Refusal => ({
  success: false,
  error,
  message,
  suggestion,
  ...extra,
});

/** Thrown inside validation, caught once at the top of `execute`, returned. */
class RequestRefused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
    this.name = 'RequestRefused';
  }
}

// Annotated on the binding, not just the arrow: TypeScript treats a call as
// terminating control flow only when the callee is a declaration with an
// explicit `never` type, and without that every refusal below would need a
// `return` after it to convince the checker the value is narrowed.
const refuse: (error: string, message: string, suggestion: string, extra?: Record<string, unknown>) => never = (
  error,
  message,
  suggestion,
  extra
) => {
  throw new RequestRefused(refusal(error, message, suggestion, extra));
};

const INVALID_FORMAT_REQUEST = 'Invalid format request';
const INVALID_RULE_REQUEST = 'Invalid conditional format request';
const NOTHING_APPLIED = 'Nothing was applied — the request is all-or-nothing. Correct it and call again.';

/**
 * A store refusal, re-labelled with the index the MODEL used.
 *
 * `planFormatOps` numbers the ops it was handed, and this module hands it a
 * list it assembled — region ops, then a derived freeze, then the model's ops
 * — so "Op 3" would name a position the model never saw. Each store op is
 * built alongside the label of the input it came from, and the store's
 * `Op N (type): ` prefix is replaced with that label.
 */
const relabel = (error: SheetFormatError, labels: readonly string[]): string => {
  const label = error.opIndex === undefined ? undefined : labels[error.opIndex];
  if (!label) return error.message;
  return `${label}: ${error.message.replace(/^Op \d+ \([^)]*\): /, '')}`;
};

// ---------------------------------------------------------------------------
// Shared: formats and colours
// ---------------------------------------------------------------------------

/**
 * Widen the model's format to the store's, normalising colours on the way.
 *
 * This is also the compile-time assertion that the AI-facing schema is a
 * subset of `CellFormat`: the spread assigns every `AiCellFormat` field into a
 * `CellFormat`, so a field added to the schema that `CellFormat` lacks, or one
 * whose type drifted, fails to compile here rather than at the store.
 */
function toCellFormat(raw: AiCellFormat, label: string): CellFormat {
  const format: CellFormat = { ...raw };
  for (const field of ['color', 'background'] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    const hex = normalizeHex(value);
    if (!hex) {
      refuse(
        INVALID_FORMAT_REQUEST,
        `${label}.${field} "${value}" is not a colour. Colours are #rrggbb (or #rgb), such as "#1d4ed8".`,
        NOTHING_APPLIED
      );
    }
    format[field] = hex;
  }
  if (Object.keys(format).length === 0) {
    refuse(
      INVALID_FORMAT_REQUEST,
      `${label} has no fields. Applying it would succeed and change nothing; name at least one, such as {"bold": true}.`,
      NOTHING_APPLIED
    );
  }
  return format;
}

const normalizeColour = (value: string, label: string, error: string): string => {
  const hex = normalizeHex(value);
  if (!hex) {
    refuse(error, `${label} "${value}" is not a colour. Colours are #rrggbb (or #rgb), such as "#1d4ed8".`, NOTHING_APPLIED);
  }
  return hex;
};

// ---------------------------------------------------------------------------
// format_sheet: ops
// ---------------------------------------------------------------------------

/**
 * Which fields each op reads. A field present on an op that does not read it
 * is REFUSED, not ignored: an agent that sent `{op: 'freeze', frozenRows: 1,
 * range: 'A1:F1', format: {bold: true}}` believes it froze AND styled, and an
 * op that silently did half of that reports success for something other than
 * what was asked.
 */
const OP_TAKES: Record<FormatOpName, readonly (keyof FormatOpInput)[]> = {
  setFormat: ['range', 'format'],
  clearFormat: ['range'],
  columnFormat: ['column', 'format'],
  columnWidth: ['column', 'width', 'clear'],
  rowHeight: ['row', 'height', 'clear'],
  freeze: ['frozenRows', 'frozenColumns', 'clear'],
};

const COLUMN_ONLY_RANGE = /^[A-Z]{1,7}(:[A-Z]{1,7})?$/;
const OPEN_ENDED_RANGE = /^[A-Z]{1,7}\d+:[A-Z]{1,7}$/;

const quoteList = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(', ');

/**
 * A range op's cell count from its corners, with both budgets applied.
 *
 * Counted, never expanded: `A1:Z100000` is 2.6 million cells, and the point
 * of refusing it is to not build that array. The store counts the same way
 * and would refuse it too, but at a higher ceiling and without naming the
 * cheaper construct.
 */
function chargeRange(range: string, label: string, budget: { used: number }): void {
  const upper = range.trim().toUpperCase();
  if (COLUMN_ONLY_RANGE.test(upper)) {
    refuse(
      INVALID_FORMAT_REQUEST,
      `${label}: "${range}" names a whole column, which a cell range cannot. Use a columnFormat op ` +
        `with column "${upper.split(':')[0]}" — it costs no cell budget and covers rows added later.`,
      NOTHING_APPLIED
    );
  }
  if (OPEN_ENDED_RANGE.test(upper)) {
    refuse(
      INVALID_FORMAT_REQUEST,
      `${label}: "${range}" has no end row. A cell range needs both corners ("A2:A500"); to cover ` +
        'rows added later use a region (whose range MAY end open, "A1:F") or a columnFormat op.',
      NOTHING_APPLIED
    );
  }

  const span = parseRangeSpan(range);
  if (!span) {
    refuse(
      INVALID_FORMAT_REQUEST,
      `${label}: "${range}" is not a range this sheet can address. Write plain A1 notation with both ` +
        'corners, such as "B2:D40" or "C7".',
      NOTHING_APPLIED
    );
  }

  const cells = (span.rowEnd - span.rowStart + 1) * (span.colEnd - span.colStart + 1);
  if (cells > MAX_FORMAT_RANGE_CELLS) {
    refuse(
      INVALID_FORMAT_REQUEST,
      `${label}: "${range}" covers ${cells.toLocaleString()} cells, over the per-op limit of ` +
        `${MAX_FORMAT_RANGE_CELLS.toLocaleString()}. ${CHEAPER_CONSTRUCTS}`,
      NOTHING_APPLIED
    );
  }
  budget.used += cells;
  if (budget.used > MAX_FORMAT_CELLS_PER_CALL) {
    refuse(
      INVALID_FORMAT_REQUEST,
      `${label}: with "${range}" this call covers ${budget.used.toLocaleString()} cells between its ` +
        `range ops, over the per-call limit of ${MAX_FORMAT_CELLS_PER_CALL.toLocaleString()}. ${CHEAPER_CONSTRUCTS}`,
      NOTHING_APPLIED
    );
  }
}

/**
 * The freeze in force, for a `freeze` op that names only one axis.
 *
 * The store's `setFrozen` sets both axes at once and reads `null` as "clear",
 * so a freeze op that mentioned only `frozenRows` would have cleared the
 * frozen columns as a side effect. An omitted axis keeps what is frozen at
 * that point in the call — the tab's snapshot, as updated by every earlier
 * op that froze or cleared. Resolving from the snapshot alone would make
 * `[freeze rows 1, freeze columns 1]` emit `{rows: null, columns: 1}` second
 * and unfreeze the row the first op had just pinned.
 */
interface CurrentFreeze {
  frozenRows: number | null;
  frozenColumns: number | null;
}

/** Validated, resolved to the store's op, and labelled for the refusal path. */
interface PlannedOp {
  op: SheetFormatOp;
  label: string;
}

function validateFormatOps(ops: readonly FormatOpInput[], initial: CurrentFreeze): PlannedOp[] {
  const planned: PlannedOp[] = [];
  const budget = { used: 0 };
  // Running, not the snapshot: each freeze op is resolved against what the
  // ops before it left frozen (see CurrentFreeze). The caller's copy is not
  // mutated, so a refusal mid-list leaves no trace.
  let current: CurrentFreeze = { ...initial };

  ops.forEach((input, index) => {
    const label = `ops[${index}]`;
    const takes = OP_TAKES[input.op];
    const present = (Object.keys(input) as (keyof FormatOpInput)[]).filter(
      (key) => key !== 'op' && input[key] !== undefined
    );

    for (const key of present) {
      if (takes.includes(key)) continue;
      refuse(
        INVALID_FORMAT_REQUEST,
        `${label}: op "${input.op}" does not read "${key}"; it takes ${quoteList(takes)}. Applying it ` +
          `would ignore "${key}" while reporting success.`,
        NOTHING_APPLIED
      );
    }

    const need = (key: keyof FormatOpInput, hint: string): void => {
      if (input[key] !== undefined) return;
      refuse(INVALID_FORMAT_REQUEST, `${label}: op "${input.op}" needs "${key}" ${hint}.`, NOTHING_APPLIED);
    };
    /** `width`/`height` XOR `clear`: setting a value and clearing it in one op asks for two things. */
    const extent = (key: 'width' | 'height', min: number, max: number): number | null => {
      const value = input[key];
      if (value !== undefined && input.clear) {
        refuse(
          INVALID_FORMAT_REQUEST,
          `${label}: op "${input.op}" has both "${key}" and "clear": true. Send one — a ${key} to set, or clear to reset.`,
          NOTHING_APPLIED
        );
      }
      if (value === undefined && !input.clear) {
        refuse(
          INVALID_FORMAT_REQUEST,
          `${label}: op "${input.op}" needs "${key}" (${min}–${max}) or "clear": true.`,
          NOTHING_APPLIED
        );
      }
      return value ?? null;
    };

    switch (input.op) {
      case 'setFormat': {
        need('range', '(the cells to style, e.g. "B2:D40")');
        need('format', '(the fields to set, e.g. {"bold": true})');
        const range = input.range as string;
        chargeRange(range, label, budget);
        planned.push({
          label,
          op: { type: 'setCellFormat', range, patch: toCellFormat(input.format as AiCellFormat, `${label}.format`) },
        });
        break;
      }
      case 'clearFormat': {
        need('range', '(the cells to clear)');
        const range = input.range as string;
        chargeRange(range, label, budget);
        planned.push({ label, op: { type: 'clearCellFormat', range } });
        break;
      }
      case 'columnFormat': {
        need('column', '(e.g. "C")');
        need('format', '(the fields to set)');
        planned.push({
          label,
          op: {
            type: 'setColumnFormat',
            column: (input.column as string).toUpperCase(),
            patch: toCellFormat(input.format as AiCellFormat, `${label}.format`),
          },
        });
        break;
      }
      case 'columnWidth': {
        need('column', '(e.g. "C")');
        const width = extent('width', MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
        planned.push({ label, op: { type: 'setColumnWidth', column: (input.column as string).toUpperCase(), width } });
        break;
      }
      case 'rowHeight': {
        need('row', '(a 1-based row number)');
        const height = extent('height', MIN_ROW_HEIGHT, MAX_ROW_HEIGHT);
        planned.push({ label, op: { type: 'setRowHeight', row: input.row as number, height } });
        break;
      }
      case 'freeze': {
        if (input.clear) {
          if (input.frozenRows !== undefined || input.frozenColumns !== undefined) {
            refuse(
              INVALID_FORMAT_REQUEST,
              `${label}: op "freeze" has "clear": true alongside a frozen count. Send one — counts to set, or clear to unfreeze both axes.`,
              NOTHING_APPLIED
            );
          }
          planned.push({ label, op: { type: 'setFrozen', rows: null, columns: null } });
          // Later ops in this call resolve their omitted axis against the
          // clear, not the snapshot — otherwise a freeze after a clear would
          // resurrect the axis the clear removed.
          current = { frozenRows: null, frozenColumns: null };
          break;
        }
        if (input.frozenRows === undefined && input.frozenColumns === undefined) {
          refuse(
            INVALID_FORMAT_REQUEST,
            `${label}: op "freeze" needs "frozenRows" and/or "frozenColumns", or "clear": true. An omitted axis keeps its current freeze.`,
            NOTHING_APPLIED
          );
        }
        const frozen: CurrentFreeze = {
          frozenRows: input.frozenRows ?? current.frozenRows,
          frozenColumns: input.frozenColumns ?? current.frozenColumns,
        };
        planned.push({
          label,
          op: { type: 'setFrozen', rows: frozen.frozenRows, columns: frozen.frozenColumns },
        });
        current = frozen;
        break;
      }
    }
  });

  return planned;
}

// ---------------------------------------------------------------------------
// format_sheet: regions
// ---------------------------------------------------------------------------

const mintId = (prefix: string, taken: ReadonlySet<string>): string => {
  for (;;) {
    const id = `${prefix}-${randomUUID().slice(0, 8)}`;
    if (!taken.has(id)) return id;
  }
};

/**
 * Normalise a declared region into what the store stores, and split off the
 * one field it does not: `freezeHeader`.
 *
 * `parseRegion` accepts `freezeHeader` and `planFormatOps` refuses it, because
 * nothing reads it yet — a stored `true` would pin no rows. `setFrozen` works
 * today, so the intent is honoured through it: a region that starts at row 1
 * and asks for a frozen header produces a freeze of its header rows, and the
 * stored region carries no `freezeHeader` at all. The freeze goes BEFORE the
 * model's own ops, so an explicit `freeze` op still wins.
 */
function validateRegions(
  regions: readonly RegionInput[],
  existingIds: ReadonlySet<string>
): { regions: SheetRegion[]; labels: string[]; frozenRows: number | undefined } {
  const out: SheetRegion[] = [];
  const labels: string[] = [];
  const taken = new Set(existingIds);
  let frozenRows: number | undefined;

  regions.forEach((input, index) => {
    const label = `regions[${index}]`;
    const range = input.range.trim().toUpperCase();
    const bounds = parseRegionRange(range);
    if (!bounds) {
      refuse(
        INVALID_FORMAT_REQUEST,
        `${label}.range "${input.range}" is not a range this sheet can address. A region is an area ` +
          'such as "A1:F40", or "A1:F" to run to the end of the sheet.',
        NOTHING_APPLIED
      );
      return;
    }

    if (input.id !== undefined && out.some((region) => region.id === input.id)) {
      refuse(INVALID_FORMAT_REQUEST, `${label}: two regions in this call share the id "${input.id}".`, NOTHING_APPLIED);
    }
    const id = input.id ?? mintId('region', taken);
    taken.add(id);

    // Built field by field in the parser's own normal form — trimmed name,
    // uppercase columns and currency codes, sorted unique total rows — because
    // the store compares what it was sent against what `parseRegion` makes of
    // it and refuses any difference. A region the parser would tidy is one the
    // store would turn away, so the tidying happens here, where it is visible.
    const region: SheetRegion = { id, range };
    const name = input.name?.trim();
    if (name) region.name = name.slice(0, 200);
    if (input.headerRows !== undefined) region.headerRows = input.headerRows;
    if (input.totalRows && input.totalRows.length > 0) {
      region.totalRows = [...new Set(input.totalRows)].sort((a, b) => a - b);
    }
    if (input.columns && input.columns.length > 0) {
      const byColumn = new Map<string, RegionColumn>();
      for (const column of input.columns) {
        byColumn.set(column.column.toUpperCase(), {
          column: column.column.toUpperCase(),
          role: column.role,
          ...(column.currency !== undefined ? { currency: column.currency.toUpperCase() } : {}),
          ...(column.decimals !== undefined ? { decimals: column.decimals } : {}),
        });
      }
      region.columns = [...byColumn.values()];
    }
    if (input.theme !== undefined) region.theme = input.theme;

    const freezeHeader = input.freezeHeader;
    if (freezeHeader === true) {
      if (bounds.rowStart !== 0) {
        refuse(
          INVALID_FORMAT_REQUEST,
          `${label}: freezeHeader pins the header only for a region that starts at row 1; this one starts ` +
            `at row ${bounds.rowStart + 1}. Drop freezeHeader, or use a freeze op with the rows you mean.`,
          NOTHING_APPLIED
        );
      }
      const headerRows = region.headerRows ?? 1;
      if (headerRows === 0) {
        refuse(
          INVALID_FORMAT_REQUEST,
          `${label}: freezeHeader with headerRows 0 pins nothing. Declare the header rows, or drop freezeHeader.`,
          NOTHING_APPLIED
        );
      }
      frozenRows = Math.max(frozenRows ?? 0, headerRows);
    }

    out.push(region);
    labels.push(label);
  });

  return { regions: out, labels, frozenRows };
}

// ---------------------------------------------------------------------------
// set_conditional_format: rules
// ---------------------------------------------------------------------------

/** Which fields each kind reads — a mirror of `FIELDS_BY_KIND`, in this tool's flat spelling. */
const RULE_TAKES: Record<RuleInput['kind'], readonly (keyof RuleInput)[]> = {
  cell: ['operator', 'value', 'value2', 'format'],
  formula: ['formula', 'format'],
  colorScale: ['min', 'mid', 'max'],
  dataBar: ['color', 'min', 'max'],
};

const asOperand = (value: string | number | undefined): string | undefined =>
  value === undefined ? undefined : String(value);

function toAnchor(raw: z.infer<typeof anchorSchema>, label: string): ScaleAnchor {
  const anchor: ScaleAnchor = { type: raw.type };
  if (raw.value !== undefined) anchor.value = raw.value;
  if (raw.color !== undefined) anchor.color = normalizeColour(raw.color, `${label}.color`, INVALID_RULE_REQUEST);
  return anchor;
}

/**
 * A rule as the store will hold it, with the id still to come, and the
 * operands the tool dropped on the way.
 *
 * `warnings` exists because of one deliberate asymmetry with the ops: a value
 * on `isEmpty` is not refused. A model that writes `{operator: 'isEmpty',
 * value: ''}` is following the shape of every other condition, and the operand
 * changes nothing about what the rule does, so the rule is accepted and the
 * operand dropped — and SAID, so the model does not learn that the value did
 * something.
 */
/**
 * `Omit` distributed over the union. A plain `Omit<ConditionalRule, 'id'>`
 * collapses the four kinds to their common keys, and `condition`, `formula`,
 * `min` and `color` all stop existing.
 */
type RuleContent = ConditionalRule extends infer Rule ? (Rule extends ConditionalRule ? Omit<Rule, 'id'> : never) : never;

interface BuiltRule {
  rule: RuleContent;
  warnings: string[];
}

function buildRule(input: RuleInput, label: string): BuiltRule {
  const takes = RULE_TAKES[input.kind];
  for (const key of Object.keys(input) as (keyof RuleInput)[]) {
    if (key === 'kind' || key === 'ranges' || input[key] === undefined || takes.includes(key)) continue;
    refuse(
      INVALID_RULE_REQUEST,
      `${label}: a ${input.kind} rule does not read "${key}"; it takes ${quoteList(takes)}. Stored, it would ` +
        'never be used.',
      NOTHING_APPLIED
    );
  }

  const ranges = input.ranges.map((range) => range.trim().toUpperCase());
  const warnings: string[] = [];
  const need = (key: keyof RuleInput, hint: string): void => {
    if (input[key] !== undefined) return;
    refuse(INVALID_RULE_REQUEST, `${label}: a ${input.kind} rule needs "${key}" ${hint}.`, NOTHING_APPLIED);
  };

  switch (input.kind) {
    case 'cell': {
      need('operator', `(one of ${OPERATORS.join(', ')})`);
      need('format', '(what to apply where the condition holds)');
      const operator = input.operator as ConditionalOperator;
      let value = asOperand(input.value);
      let value2 = asOperand(input.value2);

      if (VALUELESS_OPERATORS.has(operator)) {
        // See `BuiltRule` for why this is dropped rather than refused.
        if (value !== undefined || value2 !== undefined) {
          warnings.push(`${label}: "${operator}" compares against nothing, so its value was dropped.`);
          value = undefined;
          value2 = undefined;
        }
      } else {
        if (value === undefined || value.trim() === '') {
          refuse(
            INVALID_RULE_REQUEST,
            `${label}: "${operator}" needs "value" to compare against. Without one it matches nothing — or, ` +
              'for a negative operator, everything.',
            NOTHING_APPLIED
          );
        }
        if (RANGE_OPERATORS.has(operator)) {
          if (value2 === undefined || value2.trim() === '') {
            refuse(
              INVALID_RULE_REQUEST,
              `${label}: "${operator}" needs both bounds — "value" (lower) and "value2" (upper).`,
              NOTHING_APPLIED
            );
          }
        } else if (value2 !== undefined) {
          warnings.push(`${label}: only between/notBetween read "value2"; "${operator}" ignores it, so it was dropped.`);
          value2 = undefined;
        }
      }

      return {
        warnings,
        rule: {
          kind: 'cell',
          ranges,
          condition: {
            operator,
            ...(value !== undefined ? { value } : {}),
            ...(value2 !== undefined ? { value2 } : {}),
          },
          format: toCellFormat(input.format as AiCellFormat, `${label}.format`),
        },
      };
    }
    case 'formula': {
      need('formula', '(e.g. "=C2>AVERAGE(C:C)")');
      need('format', '(what to apply where the formula is true)');
      const formula = (input.formula as string).trim();
      if (formula === '') {
        refuse(INVALID_RULE_REQUEST, `${label}: "formula" is blank. A blank formula is dropped on the next load.`, NOTHING_APPLIED);
      }
      return {
        warnings,
        rule: {
          kind: 'formula',
          ranges,
          formula,
          format: toCellFormat(input.format as AiCellFormat, `${label}.format`),
        },
      };
    }
    case 'colorScale': {
      need('min', '(an anchor with a color, e.g. {"type": "min", "color": "#fee2e2"})');
      need('max', '(an anchor with a color, e.g. {"type": "max", "color": "#15803d"})');
      const min = toAnchor(input.min as z.infer<typeof anchorSchema>, `${label}.min`);
      const max = toAnchor(input.max as z.infer<typeof anchorSchema>, `${label}.max`);
      const mid = input.mid ? toAnchor(input.mid, `${label}.mid`) : undefined;
      for (const [name, anchor] of [['min', min], ['mid', mid], ['max', max]] as const) {
        if (anchor && !anchor.color) {
          refuse(
            INVALID_RULE_REQUEST,
            `${label}.${name}: a colorScale anchor needs a "color" to interpolate to; without one the scale renders nothing.`,
            NOTHING_APPLIED
          );
        }
      }
      return {
        warnings,
        rule: { kind: 'colorScale', ranges, min, max, ...(mid ? { mid } : {}) },
      };
    }
    case 'dataBar': {
      need('color', '(the bar colour, #rrggbb)');
      const color = normalizeColour(input.color as string, `${label}.color`, INVALID_RULE_REQUEST);
      const min = input.min ? toAnchor(input.min, `${label}.min`) : undefined;
      const max = input.max ? toAnchor(input.max, `${label}.max`) : undefined;
      return {
        warnings,
        rule: { kind: 'dataBar', ranges, color, ...(min ? { min } : {}), ...(max ? { max } : {}) },
      };
    }
  }
}

/**
 * A rule's content, independent of its id, as a string that is equal for two
 * rules that would do the same thing. Key order is canonicalised because the
 * parser rebuilds a rule field by field and a stored rule's order need not
 * match a freshly built one's.
 */
function contentKey(rule: ConditionalRule | RuleContent): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .filter((key) => key !== 'id' && (value as Record<string, unknown>)[key] !== undefined)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
      );
    }
    return value;
  };
  return JSON.stringify(canonical(rule));
}

// ---------------------------------------------------------------------------
// Shared: locating the tab
// ---------------------------------------------------------------------------

type PageRecord = NonNullable<Awaited<ReturnType<typeof pageRepository.findById>>>;

/**
 * Everything both tools do before they differ: authenticate, resolve the page,
 * check permission, check the type, refuse text-on-a-SHEET-page, find the tab
 * and read how it is formatted now.
 *
 * Permission BEFORE the type check. The wrong-type refusal quotes the page's
 * real title and type, so a type check first would answer "that page is a
 * DOCUMENT called 'Q3 Layoffs'" for any id the caller cannot see — a probe
 * that reads titles across the whole instance. `read_sheet` orders them this
 * way for the same reason.
 */
async function locateTab(
  pageIdArg: string | undefined,
  tabIndexArg: number | undefined,
  context: ToolExecutionContext,
  toolName: string
): Promise<
  | { ok: true; page: PageRecord; ref: Required<TabRef>; formatting: TabFormatting; tabs: SheetTabSummary[] }
  | { ok: false; refusal: Refusal }
> {
  const pageId = resolveOrThrowPageId(pageIdArg, context);
  const page = await pageRepository.findById(pageId);
  if (!page) {
    throw new Error(`Page with ID "${pageId}" not found`);
  }

  if (!(await canActorEditPage(context, page.id))) {
    throw new Error('Insufficient permissions to edit this sheet');
  }

  if (!isSheetType(page.type as PageType)) {
    return {
      ok: false,
      refusal: refusal(
        'Page is not a sheet',
        `This page is a ${page.type}. ${toolName} only formats SHEET pages.`,
        'Use replace_lines or insert_content for documents.',
        { pageInfo: { pageId: page.id, title: page.title, type: page.type } }
      ),
    };
  }

  const tabIndex = tabIndexArg ?? 0;
  const ref = { pageId: page.id, tabIndex };

  let tabs = toTabSummaries(await listTabs(page.id));
  if (tabs.length === 0) {
    // Not materialised. A SHEET page that holds text (or HTML) materialises to
    // an EMPTY tab without throwing, after which the text is unreachable from
    // every read path, permanently — so the document is probed as a pure read
    // first, and only a real sheet document is materialised.
    let probe: Awaited<ReturnType<typeof loadSheetWindow>>;
    try {
      probe = await loadSheetWindow(page.id, { limit: 1, documentContent: page.content });
    } catch (error) {
      if (error instanceof SheetDocumentUnreadableError) {
        return {
          ok: false,
          refusal: refusal(
            'Sheet content could not be read',
            error.message,
            'Do not treat this sheet as empty and do not format it. Ask someone to repair the stored document.'
          ),
        };
      }
      throw error;
    }
    if (probe.documentIsNotASheet) {
      return {
        ok: false,
        refusal: refusal(
          'Page holds text, not a spreadsheet',
          `"${page.title}" is a SHEET page, but its stored content is not a spreadsheet document — it holds ` +
            'plain text or HTML. There is nothing to format.',
          'Read it with read_page. Do not format it or write cells to it: that would replace the content it holds.',
          { pageInfo: { pageId: page.id, title: page.title } }
        ),
      };
    }
    tabs = probe.tabs;
  }

  if (!tabs.some((tab) => tab.tabIndex === tabIndex)) {
    return {
      ok: false,
      refusal: refusal(
        'Sheet tab not found',
        `Sheet tab ${tabIndex} does not exist. This sheet has ${tabs.length} tab(s): ` +
          tabs.map((tab) => `${tab.tabIndex} ("${tab.name}")`).join(', ') +
          '.',
        `Call ${toolName} without tabIndex for the first tab, or use one of the indexes listed.`,
        { tabs }
      ),
    };
  }

  // Materialise if needed, so the current formatting can be read from the tab
  // record. A write tool is allowed to: `edit_sheet_cells` does the same
  // through `setCells`, and the text case was refused above.
  await ensureTab(ref);
  const formatting = await readTabFormatting(ref);
  if (!formatting) {
    throw new Error(`Sheet tab ${tabIndex} could not be read after materialising page ${page.id}`);
  }

  return { ok: true, page, ref, formatting, tabs };
}

/** The write, with the store's refusals turned into the envelope. */
async function applyPlanned(
  ref: TabRef,
  planned: readonly PlannedOp[],
  formatting: TabFormatting,
  context: ToolExecutionContext,
  page: PageRecord,
  toolName: string,
  error: string,
  metadata: Record<string, unknown>
) {
  const ops = planned.map((entry) => entry.op);
  const labels = planned.map((entry) => entry.label);

  // Planned here first, on the snapshot just read, so a request the store
  // would refuse never reaches it: the mutator is called zero times on any
  // refusal, which is the atomicity claim in its testable form. The store
  // plans again under its lock, and can still refuse if the tab moved.
  try {
    planFormatOps(ops, {
      rowCount: formatting.rowCount,
      columnCount: formatting.columnCount,
      conditionalFormats: formatting.conditionalFormats,
      regions: formatting.regions,
    });
  } catch (cause) {
    if (cause instanceof SheetFormatError) {
      return refusal(error, relabel(cause, labels), NOTHING_APPLIED);
    }
    throw cause;
  }

  const mutationContext = await buildAiMutationContext(context, { metadata });
  let result: Awaited<ReturnType<typeof applyFormatOps>>;
  try {
    result = await applyFormatOps(ref, ops, {
      userId: mutationContext.userId,
      actorEmail: mutationContext.actorEmail,
      actorDisplayName: mutationContext.actorDisplayName,
      driveId: page.driveId,
      resourceTitle: page.title,
      changeGroupId: mutationContext.changeGroupId,
      metadata: { source: 'ai-tool', tool: toolName, ...metadata },
    });
  } catch (cause) {
    if (cause instanceof SheetFormatError) {
      return refusal(error, relabel(cause, labels), NOTHING_APPLIED);
    }
    throw cause;
  }

  await logSheetCellActivity({
    pageId: page.id,
    driveId: page.driveId,
    pageTitle: page.title,
    userId: mutationContext.userId,
    actorEmail: mutationContext.actorEmail,
    actorDisplayName: mutationContext.actorDisplayName,
    changeGroupId: mutationContext.changeGroupId,
    isAiGenerated: true,
    metadata: { source: 'ai-tool', tool: toolName, ...metadata },
  });

  await broadcastPageEvent(createPageEventPayload(page.driveId, page.id, 'content-updated', { title: page.title }));

  return result;
}

const isRefusal = (value: unknown): value is Refusal =>
  typeof value === 'object' && value !== null && (value as { success?: unknown }).success === false;

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export const sheetFormatTools = {
  format_sheet: tool({
    description:
      'Format a SHEET page. Declare `regions` first: a region says what an area IS — "A1:F is a table, row ' +
      '1 is its header, column C is money, row 40 is a total, accent blue" — and the sheet derives the ' +
      'presentation (header band, number formats, total emphasis, palette) at render time. A region is ' +
      'the only formatting that follows the table when rows are added, and it costs nothing on any size ' +
      'of sheet. Use `ops` only for presentation a region cannot express: one emphasised cell, a column ' +
      `width, a freeze. Budget: at most ${MAX_FORMAT_OPS_PER_CALL} ops, ` +
      `${MAX_FORMAT_RANGE_CELLS.toLocaleString()} cells per range op and ` +
      `${MAX_FORMAT_CELLS_PER_CALL.toLocaleString()} per call. ${CHEAPER_CONSTRUCTS} ` +
      'All-or-nothing: one bad op refuses the whole call and nothing is applied. Call read_sheet with ' +
      'includeFormatting first to build on what is there. Omit pageId to format the sheet in view.',
    inputSchema: formatSheetInputSchema,
    execute: async (input: FormatSheetInput, { experimental_context: context }) => {
      const toolContext = context as ToolExecutionContext;
      const userId = toolContext?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const { pageId: pageIdArg, tabIndex, regions, regionMode, ops } = input;
      const pageId = resolveOrThrowPageId(pageIdArg, toolContext);

      try {
        if ((regions?.length ?? 0) === 0 && (ops?.length ?? 0) === 0) {
          return refusal(
            INVALID_FORMAT_REQUEST,
            'Neither regions nor ops were given, so there is nothing to apply.',
            'Declare the table as a region (preferred) or send ops for the specific cells.'
          );
        }
        if (regionMode !== undefined && (regions?.length ?? 0) === 0 && regionMode !== 'replaceAll') {
          return refusal(
            INVALID_FORMAT_REQUEST,
            'regionMode was given without any regions.',
            'Send regions with it, or drop regionMode.'
          );
        }

        const located = await locateTab(pageIdArg, tabIndex, toolContext, 'format_sheet');
        if (!located.ok) return located.refusal;
        const { page, ref, formatting } = located;

        const planned: PlannedOp[] = [];

        // Regions first, then the freeze a region asked for, then the
        // model's own ops — so an explicit op layers over what a region
        // implies, never under it.
        const declared = validateRegions(
          regions ?? [],
          new Set(formatting.regions.map((region) => region.id))
        );
        if (regionMode === 'replaceAll') {
          planned.push({ label: 'regions', op: { type: 'setRegions', regions: declared.regions } });
        } else {
          declared.regions.forEach((region, index) => {
            planned.push({ label: declared.labels[index], op: { type: 'upsertRegion', region } });
          });
        }
        // The freeze the model's ops start from. A region's freezeHeader
        // lands in it, so a later `{op: 'freeze', frozenColumns: 1}` keeps
        // the header rows the region pinned instead of resolving its omitted
        // rows from the snapshot and erasing them.
        const current: CurrentFreeze = {
          frozenRows: formatting.frozenRows,
          frozenColumns: formatting.frozenColumns,
        };
        if (declared.frozenRows !== undefined) {
          current.frozenRows = declared.frozenRows;
          planned.push({
            label: 'regions (freezeHeader)',
            op: { type: 'setFrozen', rows: current.frozenRows, columns: current.frozenColumns },
          });
        }

        planned.push(...validateFormatOps(ops ?? [], current));

        const outcome = await applyPlanned(
          ref,
          planned,
          formatting,
          toolContext,
          page,
          'format_sheet',
          INVALID_FORMAT_REQUEST,
          { regions: declared.regions.length, ops: ops?.length ?? 0, regionMode: regionMode ?? 'merge' }
        );
        if (isRefusal(outcome)) return outcome;

        const regionIds = declared.regions.map((region) => region.id);
        return {
          success: true as const,
          pageId: page.id,
          title: page.title,
          tabIndex: ref.tabIndex,
          regionsApplied: declared.regions.length,
          regionIds,
          opsApplied: ops?.length ?? 0,
          cellsFormatted: outcome.cellsFormatted,
          tabFieldsChanged: outcome.tabFieldsChanged,
          regionsOnTab: outcome.regions,
          sheetDimensions: { rows: outcome.rowCount, columns: outcome.columnCount },
          message:
            `Formatted "${page.title}": ${declared.regions.length} region(s) declared, ${ops?.length ?? 0} op(s) applied` +
            (outcome.cellsFormatted > 0 ? `, ${outcome.cellsFormatted} cell(s) restyled` : '') +
            '.',
          nextSteps: [
            'Call read_sheet with includeFormatting to verify what the sheet now looks like.',
            ...(regionIds.length > 0
              ? [`Region ids ${regionIds.map((id) => `"${id}"`).join(', ')} — pass one back to restyle that table.`]
              : []),
            'Use set_conditional_format to highlight cells by value.',
          ],
        };
      } catch (error) {
        if (error instanceof RequestRefused) return error.refusal;
        sheetFormatLogger.error('Failed to format sheet', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          pageId: maskIdentifier(pageId),
          regions: regions?.length ?? 0,
          ops: ops?.length ?? 0,
        });
        throw new Error(`Failed to format sheet: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  set_conditional_format: tool({
    description:
      'Add, replace or remove conditional formatting rules on a SHEET page — highlight cells by value ' +
      '(`cell`), by a formula evaluated per cell (`formula`), as a colour gradient (`colorScale`) or ' +
      'as in-cell bars (`dataBar`). Each rule is flat: `kind` decides which fields are read, and a ' +
      'field the kind does not read is refused. Rule ids are assigned by the sheet and returned; to ' +
      'remove a rule, pass an id from read_sheet with includeFormatting. Sending the same rules twice ' +
      `adds them once. At most ${MAX_RULES_PER_CALL} rules per call and ${MAX_CONDITIONAL_RULES} per ` +
      'tab. All-or-nothing: one bad rule refuses the whole call. Omit pageId for the sheet in view.',
    inputSchema: setConditionalFormatInputSchema,
    execute: async (input: SetConditionalFormatInput, { experimental_context: context }) => {
      const toolContext = context as ToolExecutionContext;
      const userId = toolContext?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const { pageId: pageIdArg, tabIndex, mode: modeArg, rules, removeRuleIds } = input;
      const pageId = resolveOrThrowPageId(pageIdArg, toolContext);
      const mode = modeArg ?? 'append';

      try {
        if (mode === 'append' && (rules?.length ?? 0) === 0 && (removeRuleIds?.length ?? 0) === 0) {
          return refusal(
            INVALID_RULE_REQUEST,
            'No rules and no removeRuleIds were given, so there is nothing to apply.',
            'Send rules to add, ids to remove, or mode "replaceAll" with rules (an empty list clears them all).'
          );
        }
        if (mode === 'replaceAll' && (removeRuleIds?.length ?? 0) > 0) {
          return refusal(
            INVALID_RULE_REQUEST,
            'removeRuleIds does nothing under mode "replaceAll", which already discards every existing rule.',
            'Drop removeRuleIds, or use mode "append" to remove specific rules.'
          );
        }

        // Validated before any I/O: a rule that is wrong on its own is wrong
        // whatever the sheet holds.
        const built = (rules ?? []).map((rule, index) => buildRule(rule, `rules[${index}]`));
        const warnings = built.flatMap((entry) => entry.warnings);

        const located = await locateTab(pageIdArg, tabIndex, toolContext, 'set_conditional_format');
        if (!located.ok) return located.refusal;
        const { page, ref, formatting } = located;

        const existing = formatting.conditionalFormats;
        const existingIds = existing.map((rule) => rule.id);
        const planned: PlannedOp[] = [];

        let remaining: ConditionalRule[];
        if (mode === 'replaceAll') {
          planned.push({ label: 'mode', op: { type: 'clearConditionalRules' } });
          remaining = [];
        } else {
          const removals = new Set<string>();
          (removeRuleIds ?? []).forEach((id, index) => {
            if (!existingIds.includes(id)) {
              refuse(
                INVALID_RULE_REQUEST,
                `removeRuleIds[${index}]: no rule "${id}" on this tab. Rules that exist: ` +
                  (existingIds.length > 0 ? existingIds.map((existingId) => `"${existingId}"`).join(', ') : 'none') +
                  '.',
                NOTHING_APPLIED
              );
            }
            if (removals.has(id)) return;
            removals.add(id);
            planned.push({ label: `removeRuleIds[${index}]`, op: { type: 'removeConditionalRule', id } });
          });
          remaining = existing.filter((rule) => !removals.has(rule.id));
        }

        // Dedupe by content — against the rules that will still be on the
        // tab, and against earlier rules in this same call. A retried call
        // therefore adds nothing the first attempt landed.
        const byContent = new Map<string, string>(remaining.map((rule) => [contentKey(rule), rule.id]));
        const taken = new Set(existingIds);
        const ruleIds: string[] = [];
        const skippedDuplicates: { index: number; existingRuleId: string }[] = [];
        const toAdd: { rule: ConditionalRule; label: string }[] = [];

        built.forEach((entry, index) => {
          const key = contentKey(entry.rule);
          const duplicateOf = byContent.get(key);
          if (duplicateOf !== undefined) {
            ruleIds.push(duplicateOf);
            skippedDuplicates.push({ index, existingRuleId: duplicateOf });
            return;
          }
          const id = mintId('rule', taken);
          taken.add(id);
          byContent.set(key, id);
          const rule = { ...entry.rule, id } as ConditionalRule;
          ruleIds.push(id);
          toAdd.push({ rule, label: `rules[${index}]` });
        });

        const after = remaining.length + toAdd.length;
        if (after > MAX_CONDITIONAL_RULES) {
          return refusal(
            INVALID_RULE_REQUEST,
            `This tab holds ${existing.length} conditional rules and the limit is ${MAX_CONDITIONAL_RULES}; ` +
              `after this call it would hold ${after}.`,
            'Remove rules you no longer need (removeRuleIds, or mode "replaceAll"), or merge rules that ' +
              'share a format into one rule with several ranges.'
          );
        }

        for (const { rule, label } of toAdd) {
          planned.push({ label, op: { type: 'addConditionalRule', rule } });
        }

        if (planned.length === 0) {
          // Every rule was already there: the retry case, and a success.
          return {
            success: true as const,
            pageId: page.id,
            title: page.title,
            tabIndex: ref.tabIndex,
            ruleIds,
            added: 0,
            removed: 0,
            skippedDuplicates,
            conditionalRules: existing.length,
            ...(warnings.length > 0 ? { warnings } : {}),
            message: `Every rule in this call is already on "${page.title}"; nothing was added.`,
            nextSteps: ['Call read_sheet with includeFormatting to see the rules and their ids.'],
          };
        }

        const outcome = await applyPlanned(
          ref,
          planned,
          formatting,
          toolContext,
          page,
          'set_conditional_format',
          INVALID_RULE_REQUEST,
          { mode, rulesAdded: toAdd.length, rulesRemoved: existing.length - remaining.length }
        );
        if (isRefusal(outcome)) return outcome;

        return {
          success: true as const,
          pageId: page.id,
          title: page.title,
          tabIndex: ref.tabIndex,
          ruleIds,
          added: toAdd.length,
          removed: existing.length - remaining.length,
          skippedDuplicates,
          conditionalRules: outcome.conditionalRules,
          ...(warnings.length > 0 ? { warnings } : {}),
          message:
            `Conditional formatting on "${page.title}": ${toAdd.length} rule(s) added, ` +
            `${existing.length - remaining.length} removed, ${outcome.conditionalRules} on the tab now.`,
          nextSteps: [
            'Call read_sheet with includeFormatting to verify the rules.',
            'Keep the returned ruleIds to remove or replace these rules later.',
          ],
        };
      } catch (error) {
        if (error instanceof RequestRefused) return error.refusal;
        sheetFormatLogger.error('Failed to set conditional format', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          pageId: maskIdentifier(pageId),
          rules: rules?.length ?? 0,
        });
        throw new Error(`Failed to set conditional format: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),
};
