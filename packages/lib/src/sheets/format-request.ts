/**
 * What a parsed formula would do wrong at evaluation time, or null.
 *
 * Parsing proves the grammar and nothing else, so three things are checked
 * against the engine that will run it:
 *
 *  - a function name it does not implement — `evaluateFunction` throws once per
 *    covered cell and formats none of them;
 *  - a call with the wrong number of arguments, which fails exactly the same
 *    way for exactly as little;
 *  - a range large enough to take the process down. This one is not a silent
 *    no-op but a hang: `evaluation.ts` hands every `Range` to `expandRange`,
 *    which has no cap of any kind — it is two nested loops over the whole
 *    rectangle. `=SUM(A1:ZZZ5000000)>0` asks it to materialise about ninety-one
 *    billion addresses, and the rule needs to cover only one cell to get there.
 *    Bounded by the same `MAX_CONDITIONAL_RANGE_CELLS` a rule's own ranges obey.
 *
 * Iterative rather than recursive: the input is a caller-supplied formula, and
 * a walk whose depth follows it is a stack overflow escaping as a 500. (The
 * parser would usually blow up first and be caught above, but "usually" is not
 * a bound.)
 */
function formulaProblem(root: ASTNode, coveredCells: number): string | null {
  const stack: ASTNode[] = [root];
  let referenced = 0;

  while (stack.length > 0) {
    const node = stack.pop() as ASTNode;

    switch (node.type) {
      case 'FunctionCall': {
        const name = node.name.toUpperCase();
        if (!isSupportedFunction(name)) {
          return `calls ${name}(), which this sheet does not implement`;
        }
        if (!isValidCall(name, node.args.length)) {
          return (
            `calls ${name}() with ${node.args.length} ` +
            `${node.args.length === 1 ? 'argument' : 'arguments'}, which it does not accept`
          );
        }

        // Arity is checked against FLATTENED values, not argument nodes:
        // `evaluateFunction` does `args.flatMap(flattenValue)` first, so
        // `ABS(A1:A2)` arrives as two values and throws, once per covered cell.
        // Whether a function can survive that is derivable rather than listed —
        // if it would reject one more value than this call supplies, it has a
        // fixed arity and a range in any slot breaks it.
        const spreads = node.args.some(
          (argument) => argument.type === 'Range' || argument.type === 'ExternalRange'
        );
        if (spreads && !isValidCall(name, node.args.length + 1)) {
          return (
            `passes a range to ${name}(), which takes a fixed number of values — a range arrives as ` +
            'one value per cell it covers'
          );
        }

        for (const argument of node.args) stack.push(argument);
        break;
      }

      case 'Range':
      case 'ExternalRange': {
        const cells = referencedCells(node.start.reference, node.end.reference);
        if (cells === null) {
          return `refers to ${node.start.reference}:${node.end.reference}, which is not a range this sheet can address`;
        }
        if (cells > MAX_CONDITIONAL_RANGE_CELLS) {
          return (
            `refers to ${node.start.reference}:${node.end.reference}, ${cells.toLocaleString()} cells. ` +
            `Evaluating it expands every one of them, per covered cell, with no ceiling — the limit is ` +
            `${MAX_CONDITIONAL_RANGE_CELLS.toLocaleString()}`
          );
        }
        referenced += cells;
        break;
      }

      case 'UnaryExpression':
        stack.push(node.argument);
        break;

      case 'BinaryExpression':
        stack.push(node.left, node.right);
        break;

      default:
        break;
    }
  }

  // The multiplication, which neither cap above can see. A formula rule is
  // evaluated ONCE PER COVERED CELL, and each evaluation expands every range it
  // references — so a rule covering 500,000 cells whose formula sums 500,000
  // more asks for 250 billion address materialisations while clearing both
  // 500,000-cell checks. Bounded by the same ceiling that bounds conditional
  // work generally, because that is what this is: work.
  const work = coveredCells * referenced;
  if (work > MAX_FORMULA_EXPANSION) {
    return (
      `covers ${coveredCells.toLocaleString()} cells and references ${referenced.toLocaleString()} ` +
      `per cell, which is ${work.toLocaleString()} expansions to render once — the limit is ` +
      `${MAX_FORMULA_EXPANSION.toLocaleString()}`
    );
  }

  return null;
}

/** Cells in a formula's range, or null when it is not addressable. */
function referencedCells(start: string, end: string): number | null {
  const span = parseRangeSpan(`${start}:${end}`);
  return span === null ? null : cellsInSpan(span);
}

/**
 * @module @pagespace/lib/sheets/format-request
 * @description The refusal boundary for presentation writes that did not come
 * from the toolbar.
 *
 * Every setter in `format-ops` and `conditional-ops` was written for a panel,
 * where the UI is the validator: a slider cannot ask for a width of 8, and a
 * colour picker cannot emit `#gggggg`. An agent calling the same setters over
 * the API has no such fence, and the setters are *forgiving* by design — they
 * clamp, they skip unparseable addresses, they drop fields that fail their
 * schema. Forgiving is right for a load path, where the alternative is losing a
 * document; it is wrong for a write path, where it turns "I did something other
 * than what you asked" into a success response.
 *
 * So this module refuses instead, ahead of any mutation:
 *
 *  - **All-or-nothing.** One bad op refuses the batch. A partially applied
 *    format request leaves a sheet in a state nobody asked for and no caller
 *    can describe, and an agent cannot retry it without first working out what
 *    landed.
 *  - **Before I/O.** `planFormatOps` is pure and takes the tab's counters and
 *    current rule/region lists as values, so the caller can validate, learn
 *    exactly which rows the write touches, and only then take locks and load
 *    them. Validating after loading would mean holding a transaction open
 *    across work that was always going to fail.
 *  - **Never a silent no-op.** An id that is not on the sheet, a move that is
 *    already at the end, a patch with no fields — each of those returns
 *    "success" from the underlying setter while changing nothing. To a person
 *    that is a puzzling non-event; to a model it is a signal to move on, and
 *    the missing formatting surfaces much later as a bad dashboard.
 *  - **Never something OTHER than what was asked for.** The hardest of the
 *    four, because it does not look like a failure from anywhere. The stored
 *    parsers sanitize field by field — a too-small font size vanishes from a
 *    format that keeps its bold, a `ranges` array is truncated to its cap, a
 *    `headerRows` of 999 becomes the default of one — and the write reports
 *    success either way. It splits into two questions, and they need different
 *    machinery:
 *
 *    1. *Would what we store differ from what was sent?* `firstSanitizedPath`
 *       compares the two and names the first field that would not survive, so
 *       a cap the parsers learn later is covered without this module being
 *       told. `validateRanges` runs ahead of it on the caller's own array,
 *       because a check applied after the parser has already truncated that
 *       array is handed one that fits.
 *    2. *Would the thing we store do what was asked?* `ruleRenderProblem` and
 *       `regionRenderProblem`. Everything here is kept byte for byte — a
 *       formula that will not parse, a function that does not exist, an
 *       operand that compares against nothing, an anchor with no value, a hue
 *       the palette lost — so the comparison above has nothing to say about
 *       any of it, and only knowledge of what the renderer does can catch it.
 *
 *    Both are bounded by `nestsTooDeep`, because the value being checked is
 *    caller-supplied and a walk that follows it is a crash rather than a
 *    refusal.
 *
 * A word on why this is STRICTER than the panel, since the two are meant to
 * agree. They do agree about what a rule IS — the caps, the operators that need
 * an operand, the fields a format may carry — and those definitions are shared
 * rather than restated, because an API that accepts a rule the panel would not
 * offer is a bug in one of them. That shared floor is not a ceiling. Beyond it
 * this module refuses several things the panel allows, all of the same kind: a
 * formula that will not parse, a hue the palette lost, an anchor with no value.
 * A person doing any of those sees the result instantly — the cells do not
 * change colour, and they try something else. An agent gets a success response
 * and moves on, and the missing formatting surfaces days later as a dashboard
 * nobody trusts. The feedback loop is the difference, so the refusals are too.
 *
 * Pure: no database, no I/O, no clock. The refusals are the contract, and they
 * have to be testable without any of that.
 */

import {
  MAX_ADDRESSABLE_COLUMN,
  MAX_ADDRESSABLE_ROW,
  decodeCellAddress,
  decodeColumnLabel,
} from './address';
import {
  MAX_CONDITIONAL_RANGE_CELLS,
  MAX_CONDITIONAL_RULES,
  MAX_CONDITIONAL_TOTAL_CELLS,
  NUMERIC_OPERATORS,
  RANGE_OPERATORS,
  SCALE_ANCHOR_TYPES,
  VALUED_ANCHOR_TYPES,
  VALUELESS_OPERATORS,
  addressesOfRange,
  asComparableNumber,
  parseConditionalRule,
  parseConditionalRules,
  type ConditionalRule,
} from './conditional';
import { validateRanges } from './conditional-ops';
import {
  CELL_FORMAT_FIELDS,
  applyNumberFormat,
  cellFormatSchema,
  isValidHexColor,
  numberFormatToExcelCode,
} from './format';
import {
  MAX_COLUMN_WIDTH,
  MAX_ROW_HEIGHT,
  MIN_COLUMN_WIDTH,
  MIN_ROW_HEIGHT,
} from './format-ops';
import { isSupportedFunction, isValidCall } from './functions';
import { PALETTE } from './palette';
import { columnRoleFormat } from './region-format';
import { FormulaParser, tokenize } from './parser';
import {
  MAX_REGIONS,
  parseRegion,
  parseRegionRange,
  parseRegions,
  type RegionColumn,
  type SheetRegion,
} from './regions';
import type { ASTNode, CellFormat, NumberFormat } from './types';

/**
 * A caller-supplied op that cannot be applied.
 *
 * Its own class so a route can answer 400 rather than 500: every one of these
 * describes something the caller asked for, not something that went wrong on
 * the way to doing it. The message is written to be read by whatever sent the
 * op — an agent has to be able to fix the request from the refusal alone, which
 * is why they name the key, the count, or the ids that do exist.
 */
export class SheetFormatError extends Error {
  /** Index of the offending op in the batch, when one op is to blame. */
  readonly opIndex?: number;

  constructor(message: string, opIndex?: number) {
    super(message);
    this.name = 'SheetFormatError';
    this.opIndex = opIndex;
  }
}

/**
 * The presentation edits a caller can request.
 *
 * `rule` and `region` are `unknown` deliberately. `parseConditionalRule` and
 * `parseRegion` are the only definitions of "is this valid", and a value that
 * satisfies `ConditionalRule` structurally can still fail them — a
 * custom-formula rule with a blank `formula` typechecks perfectly and is
 * dropped on the next load. Typing these fields would advertise a guarantee
 * only the parsers can give, and every caller would then reasonably skip the
 * parse.
 */
export type SheetFormatOp =
  | { type: 'setCellFormat'; range: string; patch: CellFormat }
  | { type: 'clearCellFormat'; range: string }
  | { type: 'setColumnFormat'; column: string; patch: CellFormat }
  | { type: 'setColumnWidth'; column: string; width: number | null }
  | { type: 'setRowHeight'; row: number; height: number | null }
  | { type: 'setFrozen'; rows: number | null; columns: number | null }
  | { type: 'addConditionalRule'; rule: unknown }
  | { type: 'updateConditionalRule'; id: string; patch: Record<string, unknown> }
  | { type: 'removeConditionalRule'; id: string }
  | { type: 'moveConditionalRule'; id: string; direction: -1 | 1 }
  | { type: 'clearConditionalRules' }
  | { type: 'setRegions'; regions: readonly unknown[] }
  | { type: 'upsertRegion'; region: unknown }
  | { type: 'removeRegion'; id: string };

/**
 * One validated edit, resolved to the arguments its `format-ops` setter takes.
 *
 * Kept as an ordered list rather than bucketed by kind because a
 * `clearCellFormat` after a `setCellFormat` over the same cells means something
 * different from the reverse, and a plan that lost that ordering would apply
 * whichever the bucketing happened to visit last.
 *
 * `null` on the wire means "clear this", and `format-ops` spells the same thing
 * `undefined`; the translation happens here so no caller has to remember it.
 */
export type PlannedFormatStep =
  | { type: 'setCellFormat'; addresses: readonly string[]; patch: CellFormat }
  | { type: 'clearCellFormat'; addresses: readonly string[] }
  | { type: 'setColumnFormat'; columnIndex: number; patch: CellFormat }
  | { type: 'setColumnWidth'; columnIndex: number; width: number | undefined }
  | { type: 'setRowHeight'; rowIndex: number; height: number | undefined }
  | { type: 'setFrozen'; rows: number | undefined; columns: number | undefined }
  | { type: 'setConditionalRules'; rules: readonly ConditionalRule[] }
  | { type: 'setRegions'; regions: readonly SheetRegion[] };

/**
 * What the tab looks like now. A value, not a handle: `planFormatOps` runs
 * before the caller has taken a lock, and taking one to validate would hold a
 * transaction open across work that frequently ends in a refusal.
 *
 * `SheetData` satisfies this structurally, so a caller that already has one
 * passes it straight through.
 */
export interface SheetFormatTarget {
  rowCount: number;
  columnCount: number;
  conditionalFormats?: readonly ConditionalRule[];
  regions?: readonly SheetRegion[];
}

export interface SheetFormatPlan {
  /** The edits to apply, in the order they were requested. */
  steps: readonly PlannedFormatStep[];
  /**
   * Every 0-based row index the per-cell steps touch. Per-cell formats live on
   * the row records, so this is exactly the set the caller must lock and load —
   * loading the whole tab to format six cells is the thing this exists to
   * avoid.
   *
   * A row here may lie beyond `tab.rowCount`, and deliberately is not refused:
   * a column default and a region both cover rows that do not exist yet, so
   * refusing the per-cell case alone would be an inconsistency dressed as a
   * safeguard. Whether to create those rows or leave the formats unplaced is
   * the writer's decision, not the validator's — compare against `rowCount` to
   * find them.
   */
  rows: ReadonlySet<number>;
  /**
   * Whether anything on the tab record itself changes — column formats and
   * widths, row heights, freezes, rules, regions. Those live beside the tab
   * rather than on a row, so a caller that touches none of them can skip
   * writing it at all.
   */
  touchesTabFields: boolean;
  /** The rule list as it will be after the write, already round-tripped. */
  conditionalFormats: readonly ConditionalRule[];
  /** The region list as it will be after the write, already round-tripped. */
  regions: readonly SheetRegion[];
}

/**
 * The most cells one range op may address.
 *
 * Formatting a whole column cell-by-cell is the request this bound exists to
 * turn away, and turning it away is a service rather than an obstruction: a
 * column default covers rows that do not exist yet, so the refusal points at a
 * strictly better answer than the one being refused. 50,000 is past any
 * hand-authored selection and well under the per-range conditional ceiling, so
 * a range this rejects would never have been a deliberate act.
 */
export const MAX_FORMAT_CELLS = 50_000;

/**
 * The most cells one *request* may address across all of its range ops.
 *
 * The lesson `MAX_CONDITIONAL_TOTAL_CELLS` already learned, applied one layer
 * up: a per-op ceiling bounds one op and says nothing about a batch of two
 * hundred of them, each individually legal. Without an aggregate the per-op
 * bound is decorative.
 */
export const MAX_FORMAT_CELLS_PER_REQUEST = 200_000;

/** Enough for any authored batch; bounds the work of validating one. */
export const MAX_FORMAT_OPS = 200;

/**
 * The most address materialisations one formula rule may cost to render once.
 *
 * A formula rule is evaluated per covered cell and each evaluation expands
 * every range it references, so its cost is the product of the two — a factor
 * neither the per-range nor the per-sheet cell cap can see.
 *
 * Its own constant rather than a reuse of `MAX_CONDITIONAL_TOTAL_CELLS`, which
 * was the first attempt and was wrong by being far too tight. That ceiling
 * counts CELLS; this counts work, and at two million it refused the commonest
 * formula rule there is — "highlight each row above the column average" — on
 * any sheet past about 1,400 rows, because such a rule is square in the row
 * count by construction.
 *
 * Twenty million keeps that rule legal to roughly 4,500 rows, which is past the
 * sheets people actually build, and still refuses the case this bound exists
 * for by four orders of magnitude. Measured rather than guessed: `expandRange`
 * produces about 24 million addresses a second, so this is the better part of a
 * second of pure materialisation — the point where a rule stops being slow and
 * starts being a mistake.
 */
export const MAX_FORMULA_EXPANSION = 20_000_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const COLUMN_ONLY = /^[A-Z]{1,7}$/;

// Annotated rather than inferred: TypeScript only treats a call as
// terminating control flow when the callee has an explicit `never` type, and
// without that every refusal below would have to be followed by a `return` to
// convince the checker that the op is not still in play.
const refuse: (message: string, opIndex?: number) => never = (message, opIndex) => {
  throw new SheetFormatError(message, opIndex);
};

/** `Op 3 (setColumnWidth): …` — the index is what makes a batch refusal actionable. */
const refuseOp: (index: number, type: string, message: string) => never = (index, type, message) =>
  refuse(`Op ${index} (${type}): ${message}`, index);

interface RangeSpan {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

/**
 * The bounds of an A1 range, without expanding it.
 *
 * `addressesOfRange` is the shared expander and stays the only one — but a
 * *count* must be available before deciding whether expanding is allowed at
 * all, and asking the expander how big something is means building the array
 * the bound exists to prevent. This walks the same acceptances it does,
 * including rejecting the truncated `A1:` and the row-0 addresses
 * `decodeCellAddress` will happily decode to -1.
 */
function parseRangeSpan(range: string): RangeSpan | null {
  const normalized = range.trim().toUpperCase();
  const [rawStart, rawEnd, ...extra] = normalized.split(':');
  if (!rawStart || extra.length > 0) return null;
  if (normalized.includes(':') && !rawEnd) return null;

  let start: { row: number; column: number };
  let end: { row: number; column: number };
  try {
    start = decodeCellAddress(rawStart);
    end = rawEnd ? decodeCellAddress(rawEnd) : start;
  } catch {
    return null;
  }

  if (start.row < 0 || start.column < 0 || end.row < 0 || end.column < 0) return null;

  const span: RangeSpan = {
    rowStart: Math.min(start.row, end.row),
    rowEnd: Math.max(start.row, end.row),
    colStart: Math.min(start.column, end.column),
    colEnd: Math.max(start.column, end.column),
  };

  if (span.rowEnd > MAX_ADDRESSABLE_ROW || span.colEnd > MAX_ADDRESSABLE_COLUMN) return null;

  return span;
}

const cellsInSpan = (span: RangeSpan): number =>
  (span.rowEnd - span.rowStart + 1) * (span.colEnd - span.colStart + 1);

/**
 * How many cells a range contributes to conditional evaluation.
 *
 * Zero for a range the evaluator would skip, which includes one past
 * `MAX_CONDITIONAL_RANGE_CELLS` — `addressesOfRange` rejects those wholesale,
 * so counting them toward the aggregate budget would refuse a sheet for work it
 * was never going to do.
 */
function conditionalCellsOfRange(range: string): number {
  const span = parseRangeSpan(range);
  if (!span) return 0;
  const cells = cellsInSpan(span);
  return cells > MAX_CONDITIONAL_RANGE_CELLS ? 0 : cells;
}

/**
 * Validate a cell-format patch and hand back **the caller's own object**.
 *
 * The return value is `patch` itself, not `cellFormatSchema`'s output, and that
 * is the whole point of the function. `setCellFormats` treats a field present
 * and set to `undefined` as "clear this field" — that is how a toolbar turns
 * bold off without dropping the rest of the cell's styling. Zod does not
 * preserve an explicitly-undefined key: `{bold: undefined}` parses to `{}`, and
 * piping `result.data` downstream would turn every clear in the product into a
 * silent no-op that reports success.
 *
 * So `safeParse` is used for its *verdict* only. And because
 * `cellFormatSchema` is a plain `z.object`, its verdict says nothing about
 * unknown keys — it strips them without complaint, which would make a typo like
 * `bolt` a formatting request that quietly does nothing. Those are checked
 * first, by hand.
 */
function validateCellFormatPatch(
  patch: unknown,
  index: number,
  type: string,
  label = 'patch'
): CellFormat {
  if (!isObject(patch)) {
    return refuseOp(index, type, `${label} must be an object of format fields.`);
  }

  const keys = Object.keys(patch);
  if (keys.length === 0) {
    // Applying this would succeed and change nothing, which is the failure mode
    // hardest to notice from the outside.
    return refuseOp(index, type, `${label} has no fields; name at least one, such as {"bold": true}.`);
  }

  // No separate prototype-key branch. `__proto__`, `constructor` and
  // `prototype` are not format fields, so the check below already refuses them
  // by name — a mutation probe showed the extra branch changed no outcome, and
  // it is the fourth line on this branch to be removed for that reason. Nor is
  // one needed for safety here: this module hands the caller's object onward
  // untouched and never copies keys onto one of its own. `parseCellFormat`
  // keeps its own guard because it does exactly that, key by key.
  for (const key of keys) {
    if (!CELL_FORMAT_FIELDS.has(key)) {
      return refuseOp(
        index,
        type,
        `${label}: "${key}" is not a format field. Known fields: ${[...CELL_FORMAT_FIELDS].join(', ')}.`
      );
    }
  }

  const result = cellFormatSchema.safeParse(patch);
  if (!result.success) {
    const issue = result.error.issues[0];
    // Rooted at `patch` unconditionally: the path is never empty here — the
    // object and key checks above have already run — and a conditional root
    // would be a branch no input can take.
    return refuseOp(index, type, `${[label, ...issue.path].join('.')}: ${issue.message}`);
  }

  // The key check above only sees the TOP level, and `cellFormatSchema` strips
  // unknown keys from a NESTED object just as quietly: `{number: {kind:
  // 'currency', curreny: 'EUR'}}` parses successfully, renders as the default
  // currency, and loses the misspelled field on the next load. Comparing the
  // caller's object against what zod made of it catches that at any depth —
  // and leaves the top-level `undefined` clearing alone, since a raw undefined
  // is never a loss.
  // Cross-field: each number-format setting is valid on its own, and the kind
  // decides whether it is read at all.
  const number = (patch as { number?: NumberFormat }).number;
  if (number && typeof number.kind === 'string') {
    for (const [field, a, b] of [
      ['currency', 'AAA', 'BBB'],
      ['dateStyle', 'short', 'long'],
      ['decimals', 1, 4],
      ['thousands', true, false],
      ['pattern', 'a', 'b'],
    ] as const) {
      if (number[field] === undefined) continue;
      if (!ignoredNumberFormatField(number, field, a, b)) continue;
      return refuseOp(
        index,
        type,
        `${label}.number.${field} is not read by a "${number.kind}" format, so it would be stored and ` +
          'never rendered.'
      );
    }
  }

  const nested = sanitizedPathOrRefuse(patch, result.data, index, type, label);
  if (nested) {
    return refuseOp(
      index,
      type,
      `${label}.${nested} is not something this sheet can store. It would be dropped, and the field ` +
        'it belongs to rendered as if you had never set it.'
    );
  }

  // Deliberately `patch`, never `result.data`. See above.
  return patch as CellFormat;
}

/** A column label to its 0-based index, refusing what `decodeColumnLabel` would take. */
function validateColumn(column: unknown, index: number, type: string): number {
  if (typeof column !== 'string') {
    return refuseOp(index, type, 'column must be letters, such as "C".');
  }

  const normalized = column.trim().toUpperCase();
  // `decodeColumnLabel` accepts letters of any length and returns an index no
  // sheet can address; the length bound is what keeps `"AAAAAAAA"` a refusal
  // rather than a number.
  if (!COLUMN_ONLY.test(normalized)) {
    return refuseOp(index, type, `"${column}" is not a column label; use letters, such as "C".`);
  }

  const columnIndex = decodeColumnLabel(normalized);
  if (columnIndex > MAX_ADDRESSABLE_COLUMN) {
    return refuseOp(index, type, `Column "${normalized}" is past the last addressable column, ZZZ.`);
  }

  return columnIndex;
}

/**
 * A pixel measurement, refused rather than clamped when out of range.
 *
 * `setColumnWidth` and `setRowHeight` clamp — right for a drag handle, where
 * the pointer is going to overshoot and the user watches it stop. Over the API
 * it means a request for 8px reports success and produces 24px, and nothing
 * anywhere says so. Checking here leaves the clamp in place as a provable
 * no-op rather than removing a guard the panel still relies on.
 */
function validateExtent(
  value: number | null,
  min: number,
  max: number,
  field: string,
  index: number,
  type: string
): number | undefined {
  // Clearing is a real instruction, not a missing value.
  if (value === null) return undefined;

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return refuseOp(index, type, `${field} must be a number of pixels, or null to clear it.`);
  }
  if (!Number.isInteger(value)) {
    // `clamp` rounds, so a fractional request is stored as something else.
    return refuseOp(index, type, `${field} must be a whole number of pixels; got ${value}.`);
  }
  if (value < min || value > max) {
    return refuseOp(index, type, `${field} must be between ${min} and ${max} pixels; got ${value}.`);
  }

  return value;
}

/** Freeze counts are a prefix of the sheet, so they cannot exceed its extent. */
function validateFreeze(
  value: number | null,
  extent: number,
  field: string,
  index: number,
  type: string
): number | undefined {
  if (value === null) return undefined;

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return refuseOp(index, type, `${field} must be a whole number of 0 or more, or null to clear.`);
  }
  if (value > extent) {
    return refuseOp(index, type, `${field} is ${value}, but the sheet has only ${extent}.`);
  }

  return value;
}

/**
 * How deep a caller-supplied value may nest before this module stops trying to
 * verify it.
 *
 * The parsers preserve unknown fields ON PURPOSE, so a request can carry an
 * arbitrarily nested value attached to an otherwise valid rule. Walking that
 * without a bound is a `RangeError` — which escapes as a 500, the one outcome
 * `SheetFormatError` exists to prevent. Twelve is far past anything the rule
 * and region shapes reach on their own; the deepest is `borders.top.color`, at
 * three.
 */
const MAX_COMPARE_DEPTH = 12;

/**
 * How many values the comparison will look at in total, across the whole shape.
 *
 * The companion bound to the depth one, and needed for the same reason: an
 * extension field is preserved verbatim, so it can be a flat array of a million
 * entries as easily as a chain of a million objects. Ten thousand is orders of
 * magnitude past any region or rule and still cheap to walk.
 */
const MAX_COMPARE_VALUES = 10_000;

/**
 * Whether a value nests deeper than the comparison will follow.
 *
 * Checked BEFORE comparing rather than guarded during it, which is what lets
 * the comparison itself stay a plain recursive walk with nothing to say about
 * depth. Iterative, with its own stack: a recursive depth probe on a
 * caller-supplied value is the very stack overflow it exists to prevent.
 */
function tooLargeToVerify(value: unknown): string | null {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let seen = 0;

  while (stack.length > 0) {
    const current = stack.pop() as { value: unknown; depth: number };
    if (current.depth > MAX_COMPARE_DEPTH) return `nested more than ${MAX_COMPARE_DEPTH} levels deep`;

    // Depth is only half of it. A shallow value can be arbitrarily WIDE, and
    // the comparison does more than walk it — `firstSanitizedPath` builds and
    // sorts two canonical arrays out of every list it meets. A million-element
    // extension array is bounded by neither the depth cap nor anything else.
    if (++seen > MAX_COMPARE_VALUES) return `made of more than ${MAX_COMPARE_VALUES.toLocaleString()} values`;

    if (Array.isArray(current.value)) {
      for (const entry of current.value) stack.push({ value: entry, depth: current.depth + 1 });
    } else if (isObject(current.value)) {
      for (const key of Object.keys(current.value)) {
        stack.push({ value: current.value[key], depth: current.depth + 1 });
      }
    }
  }

  return null;
}

/**
 * A stable string for a value, with the normalizations the parsers are allowed
 * to perform already applied: whitespace and case on strings, key order on
 * objects, and absent-vs-undefined.
 */
function canonical(value: unknown): string {
  // Distinct from `null` on purpose. A caller who means "not set" omits the
  // key — JSON can say that — so an explicit null that comes back as nothing is
  // a real sanitization, and often a damaging one: `condition.value: null` is
  // dropped and leaves a `greaterThan` rule with no threshold, which matches no
  // cell and looks like a rule that simply does not work.
  if (value === undefined) return '<absent>';
  if (typeof value === 'string') return JSON.stringify(value.trim().toLowerCase());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The first path at which the parser altered or dropped something the caller
 * supplied, or null when everything survived.
 *
 * This is the same argument as the round-trip detector, one level down.
 * `parseConditionalRule` and `parseRegion` are LOAD-path parsers: they sanitize
 * field by field so that one bad setting cannot cost a user the rest of a
 * stored document. Reused as-is on the write path, that generosity becomes a
 * lie — `format: {bold: true, fontSize: 5}` stores the bold, drops the size and
 * reports success; `ranges` past `MAX_CONDITIONAL_RANGES_PER_RULE` is truncated
 * to the cap and the caps that would have refused it then see a rule that fits;
 * `headerRows: 999` silently becomes the default of one.
 *
 * Rather than restate every one of those rules here — a second copy of the
 * parsers, free to drift from them — the parser stays the specification and
 * this asks the only question that matters: is what we are about to store still
 * what was asked for? Anything the parsers learn to sanitize later is covered
 * without being taught.
 *
 * What it must NOT flag is a genuine normalization, so strings compare
 * case- and whitespace-insensitively (a range is upper-cased, a colour
 * lower-cased, a currency code upper-cased) and lists compare as multisets
 * (`totalRows` comes back sorted). A shorter list is always a loss, which is
 * what catches a truncated `ranges` array and a dropped column declaration.
 */
function firstSanitizedPath(raw: unknown, stored: unknown, path: string): string | null {
  // Absent and explicitly-undefined need no case of their own. The object walk
  // below visits the keys of RAW only, so a key the parser added is never
  // reached, and a key the caller set to `undefined` against a parser that
  // dropped it compares `<absent>` to `<absent>` at the bottom. An explicit
  // `null` is NOT the same thing and deliberately falls through to that same
  // comparison; see `canonical`.
  //
  // An identity fast path (`raw === stored`) used to sit here, on the grounds
  // that the parsers preserve an unknown field by passing the same reference
  // through. It was removed: `nestsTooDeep` already bounds the walk, so it
  // optimised a bounded operation, and no test could tell whether it was there
  // — an object cannot be sanitized into itself, so it never changed an answer.

  if (Array.isArray(raw) || Array.isArray(stored)) {
    if (!Array.isArray(raw) || !Array.isArray(stored)) return path;
    const left = raw.map(canonical).sort();
    const right = stored.map(canonical).sort();
    // No separate length check: a list that comes back SHORTER shows up as a
    // mismatch at the first position the parser dropped, and one that comes
    // back longer is the parser filling something in, which is not a loss.
    return left.every((entry, position) => entry === right[position]) ? null : path;
  }

  if (isObject(raw)) {
    if (!isObject(stored)) return path;
    for (const key of Object.keys(raw)) {
      const found = firstSanitizedPath(raw[key], stored[key], path === '' ? key : `${path}.${key}`);
      if (found) return found;
    }
    // A field the parser ADDS is not a loss — a default filled in is still the
    // request being honoured.
    return null;
  }

  return canonical(raw) === canonical(stored) ? null : path;
}

/**
 * `firstSanitizedPath`, with the depth bound applied first.
 *
 * Every caller wants the same thing from a value nested past what this module
 * will verify: refuse it. Silently accepting what could not be checked would
 * make the bound a hole rather than a limit.
 */
function sanitizedPathOrRefuse(
  raw: unknown,
  stored: unknown,
  index: number,
  type: string,
  label: string
): string | null {
  const tooLarge = tooLargeToVerify(raw);
  if (tooLarge) {
    return refuseOp(
      index,
      type,
      `${label} is ${tooLarge}, which is past what this sheet will check for silent changes. ` +
        'Simplify it.'
    );
  }

  return firstSanitizedPath(raw, stored, '');
}

/**
 * Why a scale anchor is unusable, in words, or null when it is fine.
 *
 * The one class of damage the readback comparator is blind to, because nothing
 * is dropped: when `readAnchor` cannot read an anchor it returns null, and the
 * rule builders then keep the caller's original through their `...value`
 * spread. The anchor is stored EXACTLY as written — and quietly means something
 * else. `anchorValue` substitutes the data's own minimum or maximum for an
 * unreadable type, and a `colorScale` whose `mid` has no usable colour renders
 * nothing at all: `mixColors` returns null for both halves of the gradient, so
 * every cell in range comes back unpainted. Measured, not assumed — swapping
 * that one `mid.color` for a valid hex takes the same rule from zero formatted
 * cells to every cell painted.
 */
const anchorProblem = (anchor: unknown, needsColor: boolean): string | null => {
  if (anchor === undefined) return null;

  if (!isObject(anchor) || typeof anchor.type !== 'string' || !SCALE_ANCHOR_TYPES.has(anchor.type)) {
    return `needs a type of ${[...SCALE_ANCHOR_TYPES].join(', ')}`;
  }
  if (needsColor && !isValidHexColor(anchor.color)) {
    return 'needs a #rrggbb colour';
  }
  if (!needsColor && anchor.color !== undefined) {
    // The other direction: a data bar takes its colour from `rule.color`, and
    // the evaluator reads only `type` and `value` off these anchors. A colour
    // here is validated, stored, and never drawn.
    return 'takes its colour from the rule, so the anchor cannot carry one';
  }

  // `min` and `max` read the data's own extremes and ignore any value. The
  // other three ARE their value — and `anchorValue` quietly substitutes an
  // extreme for a missing one and clamps an out-of-range percent, so both are
  // stored intact and mean something else.
  if (VALUED_ANCHOR_TYPES.has(anchor.type)) {
    if (typeof anchor.value !== 'number' || !Number.isFinite(anchor.value)) {
      return `of type ${anchor.type} needs a numeric value`;
    }
    if (anchor.type !== 'number' && (anchor.value < 0 || anchor.value > 100)) {
      return `of type ${anchor.type} needs a value from 0 to 100, not ${anchor.value}`;
    }
  } else if (anchor.value !== undefined) {
    // The other direction of the same mistake: `min` and `max` read the data's
    // own extremes and `anchorValue` never looks at a value, so one supplied
    // here is stored and silently replaced by whatever the data happens to hold.
    return `of type ${anchor.type} reads the data's own extreme, so it cannot take a value of ${String(anchor.value)}`;
  }

  return null;
};

/**
 * Why a rule that stores faithfully would still not do what was asked, or null
 * when there is nothing wrong with it.
 *
 * The second half of this module's job, and a different question from the
 * first. `firstSanitizedPath` asks whether what we are about to store matches
 * what was sent; these ask whether the thing we are about to store does what
 * was asked. Every case here passes the first question perfectly — the rule is
 * kept byte for byte — and then formats the wrong cells, or none.
 */
function ruleRenderProblem(
  rule: ConditionalRule,
  supplied: Record<string, unknown>
): string | null {
  // A format on a rule kind that has none. `ConditionalColorScaleRule` and
  // `ConditionalDataBarRule` do not declare one, and the evaluator agrees: the
  // colorScale branch contributes a background from the gradient and the
  // dataBar branch contributes a bar, and neither reads `rule.format`.
  // Verified by evaluating both kinds with and without one — byte-identical
  // output. So a whole format is validated, stored, and never drawn.
  //
  // Read from what the CALLER sent, not the merged rule, so a stored stray does
  // not make every later update to that rule impossible.
  if ((rule.kind === 'colorScale' || rule.kind === 'dataBar') && supplied.format !== undefined) {
    return `A ${rule.kind} rule draws from its anchors, not a format, so the format would never be drawn.`;
  }

  // A condition whose operator needs an operand it does not have. The parser
  // accepts any recognized operator on its own and the comparator sees nothing
  // dropped, but `matchesCondition` then compares against nothing: a
  // `greaterThan` with no value matches NO cell, and a `notContains` with no
  // value matches EVERY non-error one. Which set of operators needs a value is
  // the panel's answer, now shared rather than restated.
  if (rule.kind === 'cell') {
    const { operator, value, value2 } = rule.condition;

    // An operand the operator never reads. `matchesCondition` looks at `value`
    // only for the operators that compare against something, and at `value2`
    // only for the two range operators — so `isEmpty` with a value, or
    // `greaterThan` with a second bound, is part of the caller's instruction
    // stored and thrown away. Neither shape is reachable through the panel,
    // which hides the fields it does not use.
    if (VALUELESS_OPERATORS.has(operator) && (value !== undefined || value2 !== undefined)) {
      return `"${operator}" compares against nothing, so it cannot take a value.`;
    }
    if (!RANGE_OPERATORS.has(operator) && value2 !== undefined) {
      return `Only a between/notBetween rule has a second bound; "${operator}" ignores value2.`;
    }

    // And the mirror: an operand the operator needs and does not have. The
    // parser accepts any recognized operator on its own and the comparator sees
    // nothing dropped, but `matchesCondition` then compares against nothing —
    // a `greaterThan` with no value matches NO cell, and a `notContains` with
    // no value matches EVERY non-error one.
    if (!VALUELESS_OPERATORS.has(operator)) {
      if (typeof value !== 'string' || value.trim() === '') {
        return (
          `"${operator}" needs a value to compare against. Without one it matches nothing — or, for a ` +
          'negative operator, everything.'
        );
      }
      if (RANGE_OPERATORS.has(operator) && (typeof value2 !== 'string' || value2.trim() === '')) {
        return `"${operator}" needs both bounds: value and value2.`;
      }

      // Present, non-blank, and still nothing to compare against: the operand
      // is coerced and returns null, so the rule is false for every cell it
      // covers. `equal`/`notEqual` are absent from the set on purpose — they
      // fall back to a text comparison, so `= "done"` is a real rule.
      if (NUMERIC_OPERATORS.has(operator)) {
        for (const [field, operand] of [['value', value], ['value2', value2]] as const) {
          if (operand === undefined) continue;
          if (asComparableNumber(operand) === null) {
            return (
              `"${operator}" compares numbers, and ${field} is "${operand}". It would match no cell ` +
              'at all.'
            );
          }
        }
      }
    }
  }

  if (rule.kind === 'formula') {
    const body = rule.formula.trim().replace(/^=/, '');
    let ast: ASTNode | null = null;
    try {
      const tokens = tokenize(body);
      if (tokens.length > 0) ast = new FormulaParser(tokens).parse();
    } catch {
      ast = null;
    }
    if (!ast) {
      return (
        `"${rule.formula}" is not a formula this sheet can evaluate. Stored as written it throws once ` +
        'per covered cell and formats none of them.'
      );
    }

    // Parsing proves the grammar and nothing else — see `formulaProblem` for
    // the three things the engine will object to that a parse cannot see.
    const covered = rule.ranges.reduce((cells, range) => cells + conditionalCellsOfRange(range), 0);
    const problem = formulaProblem(ast, covered);
    if (problem) return `"${rule.formula}" ${problem}.`;
  }

  // Anchors, which the comparator cannot speak for — see `anchorProblem`.
  if (rule.kind === 'colorScale') {
    for (const [name, value] of [['min', rule.min], ['mid', rule.mid], ['max', rule.max]] as const) {
      const problem = anchorProblem(value, true);
      if (problem) {
        return (
          `The colorScale's ${name} anchor ${problem}. Stored as written it renders no colour at ` +
          'all, on any cell in range.'
        );
      }
    }
  } else if (rule.kind === 'dataBar') {
    for (const [name, value] of [['min', rule.min], ['max', rule.max]] as const) {
      const problem = anchorProblem(value, false);
      if (problem) {
        return (
          `The dataBar's ${name} anchor ${problem}. Stored as written it is ignored, and the bars ` +
          `are scaled to the data's own ${name} instead.`
        );
      }
    }
  }

  return null;
}

/**
 * Parse a caller-supplied rule, refusing anything the parser would quietly
 * rewrite on the way in.
 *
 * Order matters here and is the whole point: `validateRanges` runs against the
 * caller's own `ranges`, before `parseConditionalRule` has had a chance to
 * slice the array down to `MAX_CONDITIONAL_RANGES_PER_RULE`. Run afterwards it
 * would be handed the truncated list, pronounce it fine, and the ranges past
 * the cap would be gone with no refusal anywhere.
 */
function validateRuleInput(
  raw: unknown,
  supplied: Record<string, unknown>,
  index: number,
  type: string,
  charge: (cells: number) => void
): ConditionalRule {
  if (!isObject(raw)) {
    return refuseOp(index, type, 'rule must be an object.');
  }

  // Both checks below are STRICTER than the parser, so they may only be applied
  // to fields this request actually carries. `raw` is the whole rule, which for
  // an update is mostly the stored one — and a stored rule is a fixed point of
  // the parser, not of these. Holding it to them would refuse an unrelated
  // update to any rule a newer build wrote (`parseCellFormat` preserves an
  // unknown field, and the key check would then reject it) — the same
  // cross-version data loss the passthrough exists to prevent, arriving as a
  // refusal instead. It also keeps this identical to the panel's `updateRule`,
  // which validates `patch.ranges` and nothing else.
  const suppliedRanges = supplied.ranges;
  if (suppliedRanges !== undefined) {
    if (!isStringArray(suppliedRanges)) {
      return refuseOp(index, type, 'ranges must be an array of A1 ranges, such as ["B2:B20"].');
    }
    // Bounds BEFORE `validateRanges`, because `validateRanges` expands each
    // range and `addressesOfRange` bounds only the cell COUNT and negative
    // coordinates — never the addressable extent. So `A5000002` sails through
    // as one legal cell, and a row number large enough to lose float precision
    // (`A1000000000000000000000`) is worse than merely out of range: `row++`
    // stops advancing at that magnitude, so the expansion loop runs to its
    // 500,000-address ceiling emitting the same malformed exponential-form
    // address every time, inside what is supposed to be a cheap check.
    for (const range of suppliedRanges) {
      if (!parseRangeSpan(range)) {
        return refuseOp(index, type, `"${range}" is not a range this sheet can address.`);
      }
    }

    // Counted cheaply and charged to the request's budget BEFORE
    // `validateRanges`, which expands every range to addresses. A per-rule cap
    // bounds one rule at half a million cells and says nothing about a batch of
    // two hundred of them — the same hole `MAX_FORMAT_CELLS_PER_REQUEST` closes
    // on the cell path, and leaving it open here would make that bound the only
    // one doing its job.
    charge(suppliedRanges.reduce((cells, range) => cells + conditionalCellsOfRange(range), 0));

    // The caller's array, at its real length.
    const ranges = validateRanges(suppliedRanges);
    if (!ranges.ok) return refuseOp(index, type, ranges.reason);
  }

  // Checked explicitly rather than left to the comparator below because
  // `parseCellFormat` carries an unknown field THROUGH untouched — nothing is
  // lost, so nothing would be flagged, and a typo like `bolt` would be stored
  // as an inert field that formats nothing.
  //
  // Which is why an unknown field is refused inside a `format` and accepted at
  // the top of a rule, an asymmetry worth stating: a format has an
  // authoritative list of known fields to measure a typo against, and `bolt`
  // for `bold` is a near miss an agent will really make. A rule's own shape has
  // no such list — it is a union of four kinds the parser deliberately spreads
  // over — so there is nothing to be confident a stray field is a mistake
  // against. The line is drawn where the certainty is.
  if (supplied.format !== undefined) {
    validateCellFormatPatch(supplied.format, index, type, 'rule format');
  }

  const rule = parseConditionalRule(raw);
  if (!rule) {
    return refuseOp(
      index,
      type,
      'That is not a rule this sheet can store. A rule needs an id, at least one range, and a ' +
        'kind of cell, formula, colorScale or dataBar — a formula rule needs a non-empty formula, ' +
        'and a cell rule a format with at least one valid field.'
    );
  }

  const sanitized = sanitizedPathOrRefuse(raw, rule, index, type, 'This rule');
  if (sanitized) {
    return refuseOp(
      index,
      type,
      `"${sanitized}" is not something this sheet can store, and would be dropped or changed on the ` +
        'way in. Nothing about a stored rule may differ from what was asked for.'
    );
  }

  const problem = ruleRenderProblem(rule, supplied);
  if (problem) return refuseOp(index, type, problem);

  return rule;
}

/**
 * A number-format setting the chosen `kind` never reads, or null.
 *
 * `numberFormatSchema` validates each field on its own, so
 * `{kind: 'number', dateStyle: 'long'}` and `{kind: 'date', currency: 'EUR'}`
 * both pass — and `applyNumberFormat` then reads neither, so part of the
 * requested presentation is stored and has no effect. The toolbar avoids this
 * by dropping settings that do not apply when the kind changes; a caller has
 * nothing dropping them.
 *
 * Asked of the renderers rather than answered from a table of which kind reads
 * what: render twice with two different values for the field and see whether
 * anything moves. Both renderers are consulted, because a field the display
 * ignores may still reach the exported workbook — `dateStyle` on a `date` kind
 * is read by one and not the other — and a setting that changes either output
 * is doing something.
 *
 * The probe values cover the shapes `applyNumberFormat` switches on: a number
 * for the numeric kinds, an ISO timestamp for the date ones, and text.
 */
const PROBE_VALUES = [1234.5678, '2026-09-08T13:45:56', 'text'] as const;

function ignoredNumberFormatField(
  format: NumberFormat,
  field: 'currency' | 'dateStyle' | 'decimals' | 'thousands' | 'pattern',
  a: unknown,
  b: unknown
): boolean {
  const render = (value: unknown): string => {
    const candidate = { ...format, [field]: value } as NumberFormat;
    return [
      ...PROBE_VALUES.map((probe) => String(applyNumberFormat(probe, candidate))),
      String(numberFormatToExcelCode(candidate)),
    ].join('\u0000');
  };

  return render(a) === render(b);
}

/**
 * Whether a column setting has any effect on what that column renders, asked of
 * the deriver rather than assumed.
 *
 * `columnRoleFormat` reads `currency` only for `role: 'currency'` and `decimals`
 * only for the three numeric roles, so `{role: 'number', currency: 'EUR'}` is
 * stored, ignored, and looks from the outside like money that lost its symbol.
 *
 * Answered by deriving the format twice with two ARBITRARY, different values
 * for the field: identical output means the field was not read, whatever the
 * caller happened to send. The tempting shortcut — derive once with the
 * caller's value and once without it — asks a different question and gets
 * `currency: 'USD'` on a currency column wrong, because the role defaults to
 * USD anyway, so the two derivations match and a redundant declaration is
 * reported as an ignored one. Redundant is not a mistake.
 */
const columnFieldIsIgnored = (
  column: RegionColumn,
  field: 'currency' | 'decimals',
  a: string | number,
  b: string | number
): boolean =>
  canonical(columnRoleFormat({ ...column, [field]: a })) ===
  canonical(columnRoleFormat({ ...column, [field]: b }));

/**
 * The same question as {@link ruleRenderProblem}, for a region: what would be
 * stored exactly as asked and still not do it?
 */
function regionRenderProblem(region: SheetRegion, label: string): string | null {
  // A declaration that names something outside the region it belongs to.
  // `createRegionResolver` excludes cells outside the bounds before it consults
  // either list, so a column or total row beyond them can never render — stored
  // faithfully, and inert. Cross-field, so the comparator cannot see it: each
  // value survives on its own.
  const bounds = parseRegionRange(region.range);
  if (bounds) {
    for (const column of region.columns ?? []) {
      const columnIndex = decodeColumnLabel(column.column);
      if (columnIndex < bounds.colStart || columnIndex > bounds.colEnd) {
        return (
          `${label}: column "${column.column}" is outside the region ${region.range}, so nothing it ` +
          'declares can ever apply.'
        );
      }
    }

    // Totals are checked against the region's BODY, not its bounds. The
    // resolver applies the header treatment and `continue`s, so a total row
    // inside the header band never reaches the total treatment at all — and a
    // region that starts below row 1 has rows above it that are simply not
    // part of it. Both store cleanly and render as something else.
    const headerRows = region.headerRows ?? 1;
    const firstBodyRow = bounds.rowStart + headerRows;

    // A closed region whose header band fills it has no body at all — the
    // resolver treats every covered row as a header and `continue`s before it
    // consults the column map. Column roles declared on it can never render,
    // and unlike an open region it cannot grow into a body later.
    if (bounds.rowEnd !== null && firstBodyRow > bounds.rowEnd && (region.columns?.length ?? 0) > 0) {
      return (
        `${label}: ${region.range} is ${bounds.rowEnd - bounds.rowStart + 1} rows tall and every one ` +
        'of them is a header, so it has no body for a column role to apply to.'
      );
    }

    for (const row of region.totalRows ?? []) {
      if (row - 1 < firstBodyRow) {
        return (
          `${label}: total row ${row} is not in the body of ${region.range}. That region starts at ` +
          `row ${bounds.rowStart + 1} and its first ${headerRows} ` +
          `${headerRows === 1 ? 'row is a header' : 'rows are headers'}, so its totals start at row ` +
          `${firstBodyRow + 1}.`
        );
      }

      // The upper bound is skipped for an open range only ("A1:F" reaches the
      // end of the sheet), so a total row past today's extent is a row the
      // sheet will grow into — the entire point of leaving the end off.
      if (bounds.rowEnd !== null && row - 1 > bounds.rowEnd) {
        return `${label}: total row ${row} is outside the region ${region.range}, so it can never render.`;
      }
    }
  }

  for (const column of region.columns ?? []) {
    for (const [field, a, b] of [
      ['currency', 'AAA', 'BBB'],
      ['decimals', 1, 2],
    ] as const) {
      if (column[field] === undefined) continue;
      if (!columnFieldIsIgnored(column, field, a, b)) continue;
      return (
        `${label}: column ${column.column} declares ${field}, which a "${column.role}" column does ` +
        'not use — it would be stored and never rendered.'
      );
    }
  }

  // A setting nothing acts on yet. `freezeHeader` is parsed and stored, and a
  // repo-wide search finds no consumer: `createRegionResolver` does not read it
  // and the `setRegions` step only stores the region. Accepting it would be the
  // module's own contract broken in its own output — a request that succeeds
  // and pins nothing. `setFrozen` does work today, so the refusal names it.
  if (region.freezeHeader === true) {
    return (
      `${label}: freezeHeader is not applied by anything yet, so setting it would pin no rows. Use a ` +
      'setFrozen op for now.'
    );
  }

  // The one sanitization the comparator cannot see, because it happens at
  // RENDER time rather than at parse time: `parseRegion` accepts any lowercase
  // word as a theme, and `hueByName` then falls back to the default for one the
  // palette does not have. Its own comment says why — "falling back beats
  // refusing to render the table" — and that is right for a stored region being
  // drawn. It is wrong for a request: an agent that asked for a blue dashboard
  // and got slate was told the write succeeded. Refusing needs the palette,
  // which is exactly what that comment notes `parseRegion` cannot import.
  if (region.theme !== undefined && !PALETTE.some((hue) => hue.name === region.theme)) {
    return (
      `${label}: "${region.theme}" is not a hue this build has, and would render as ` +
      `${PALETTE[0].name} without saying so. Known hues: ${PALETTE.map((hue) => hue.name).join(', ')}.`
    );
  }

  return null;
}

/** The same contract as {@link validateRuleInput}, for a declared region. */
function validateRegionInput(raw: unknown, index: number, type: string, label: string): SheetRegion {
  const region = parseRegion(raw);
  if (!region) {
    return refuseOp(
      index,
      type,
      `${label} is not a region this sheet can store. A region needs an id and a range such as ` +
        '"A1:F" (an omitted row end means "to the end of the sheet").'
    );
  }

  const sanitized = sanitizedPathOrRefuse(raw, region, index, type, label);
  if (sanitized) {
    // `parseRegion` drops a bad optional setting and keeps the region, so
    // `headerRows: 999` becomes the default of one and an unusable column
    // declaration disappears — in both cases the sheet stores something the
    // caller did not ask for and hears that it worked.
    return refuseOp(
      index,
      type,
      `${label}: "${sanitized}" is not something this sheet can store, and would be dropped or ` +
        'changed on the way in.'
    );
  }

  const problem = regionRenderProblem(region, label);
  if (problem) return refuseOp(index, type, problem);

  return region;
}

/** The id an op names, which must be there to name anything at all. */
const requireId = (id: unknown, index: number, type: string): string =>
  typeof id === 'string' && id !== '' ? id : refuseOp(index, type, 'id must be a non-empty string.');

const ruleIdList = (rules: readonly ConditionalRule[]): string =>
  rules.length === 0 ? 'none' : rules.map((rule) => `"${rule.id}"`).join(', ');

const regionIdList = (regions: readonly SheetRegion[]): string =>
  regions.length === 0 ? 'none' : regions.map((region) => `"${region.id}"`).join(', ');

/**
 * Validate a whole format request against the tab as it stands, and describe
 * the write it would perform.
 *
 * Throws `SheetFormatError` on the first op it cannot apply, before returning
 * anything — there is no partial plan, because there is no partial write.
 */
export function planFormatOps(
  ops: readonly SheetFormatOp[],
  tab: SheetFormatTarget
): SheetFormatPlan {
  if (!Array.isArray(ops)) {
    refuse('ops must be an array of format operations.');
  }
  if (ops.length > MAX_FORMAT_OPS) {
    refuse(`A format request can carry at most ${MAX_FORMAT_OPS} ops; got ${ops.length}.`);
  }

  const steps: PlannedFormatStep[] = [];
  const rows = new Set<number>();
  let touchesTabFields = false;
  let cellsPlanned = 0;

  // Rules and regions are folded into one running list each, so a batch that
  // adds three rules and moves one is checked against — and stored as — the
  // list those four ops actually produce. Checking each op against the stored
  // list instead would let a batch land past a cap that every op individually
  // cleared.
  let rules: ConditionalRule[] = [...(tab.conditionalFormats ?? [])];
  let regions: SheetRegion[] = [...(tab.regions ?? [])];
  let rulesTouched = false;
  let regionsTouched = false;

  // How many cells this request has asked us to EXPAND while checking rules,
  // as opposed to how many the resulting sheet covers. Bounded by the same
  // sheet-wide ceiling, because a request whose rules alone reach past it can
  // never be the repair that ceiling makes an exception for.
  let conditionalCellsInspected = 0;
  const chargeInspection = (index: number, type: string) => (cells: number) => {
    conditionalCellsInspected += cells;
    if (conditionalCellsInspected > MAX_CONDITIONAL_TOTAL_CELLS) {
      refuseOp(
        index,
        type,
        `The rules in this request cover ${conditionalCellsInspected.toLocaleString()} cells between ` +
          `them, past the sheet-wide limit of ${MAX_CONDITIONAL_TOTAL_CELLS.toLocaleString()} before ` +
          'the sheet is even considered.'
      );
    }
  };

  /** A range op's addresses, with both the per-op and per-request bounds applied. */
  const resolveRange = (range: unknown, index: number, type: string): readonly string[] => {
    if (typeof range !== 'string') {
      return refuseOp(index, type, 'range must be a string, such as "B2:D40".');
    }

    const span = parseRangeSpan(range);
    if (!span) {
      return refuseOp(index, type, `"${range}" is not a range this sheet can address.`);
    }

    const cells = cellsInSpan(span);
    if (cells > MAX_FORMAT_CELLS) {
      return refuseOp(
        index,
        type,
        `"${range}" covers ${cells.toLocaleString()} cells, over the limit of ` +
          `${MAX_FORMAT_CELLS.toLocaleString()}. Use setColumnFormat for a whole column, or a region ` +
          `for a table — both cover rows that do not exist yet.`
      );
    }

    cellsPlanned += cells;
    if (cellsPlanned > MAX_FORMAT_CELLS_PER_REQUEST) {
      return refuseOp(
        index,
        type,
        `This request now covers ${cellsPlanned.toLocaleString()} cells, over the per-request limit ` +
          `of ${MAX_FORMAT_CELLS_PER_REQUEST.toLocaleString()}.`
      );
    }

    for (let row = span.rowStart; row <= span.rowEnd; row++) rows.add(row);

    return addressesOfRange(range, MAX_FORMAT_CELLS);
  };

  ops.forEach((op, index) => {
    // Checked through a boolean rather than an `isObject(op)` narrowing: a type
    // predicate here would intersect the op union with `Record<string, unknown>`
    // and every field below would arrive as `unknown`, costing a cast per field
    // to recover what the union already says.
    const shaped =
      typeof op === 'object' &&
      op !== null &&
      !Array.isArray(op) &&
      typeof (op as { type?: unknown }).type === 'string';
    if (!shaped) {
      refuse(`Op ${index}: each op must be an object with a "type".`, index);
    }

    switch (op.type) {
      case 'setCellFormat': {
        // Patch first: it is a handful of key lookups, while resolving the
        // range expands up to `MAX_FORMAT_CELLS` addresses. A request that was
        // always going to be refused for a typo should not pay for that.
        const patch = validateCellFormatPatch(op.patch, index, op.type);
        steps.push({ type: 'setCellFormat', addresses: resolveRange(op.range, index, op.type), patch });
        break;
      }

      case 'clearCellFormat': {
        steps.push({ type: 'clearCellFormat', addresses: resolveRange(op.range, index, op.type) });
        break;
      }

      case 'setColumnFormat': {
        const columnIndex = validateColumn(op.column, index, op.type);
        steps.push({
          type: 'setColumnFormat',
          columnIndex,
          patch: validateCellFormatPatch(op.patch, index, op.type),
        });
        touchesTabFields = true;
        break;
      }

      case 'setColumnWidth': {
        const columnIndex = validateColumn(op.column, index, op.type);
        const width = validateExtent(
          op.width,
          MIN_COLUMN_WIDTH,
          MAX_COLUMN_WIDTH,
          'width',
          index,
          op.type
        );
        steps.push({ type: 'setColumnWidth', columnIndex, width });
        touchesTabFields = true;
        break;
      }

      case 'setRowHeight': {
        const row = op.row;
        // 1-based on the wire, as everywhere a row is named in A1 terms — so
        // the bound is `row - 1`, since `MAX_ADDRESSABLE_ROW` is a 0-based
        // index everywhere it is compared. Comparing `row` to it directly left
        // the last addressable row able to take a cell format but not a row
        // height, which is the kind of disagreement no caller can see coming.
        if (typeof row !== 'number' || !Number.isInteger(row) || row < 1 || row - 1 > MAX_ADDRESSABLE_ROW) {
          refuseOp(index, op.type, `row must be a 1-based row number; got ${String(row)}.`);
        }
        const height = validateExtent(
          op.height,
          MIN_ROW_HEIGHT,
          MAX_ROW_HEIGHT,
          'height',
          index,
          op.type
        );
        steps.push({ type: 'setRowHeight', rowIndex: row - 1, height });
        touchesTabFields = true;
        break;
      }

      case 'setFrozen': {
        const frozenRows = validateFreeze(
          op.rows,
          tab.rowCount,
          'frozen rows',
          index,
          op.type
        );
        const frozenColumns = validateFreeze(
          op.columns,
          tab.columnCount,
          'frozen columns',
          index,
          op.type
        );
        steps.push({ type: 'setFrozen', rows: frozenRows, columns: frozenColumns });
        touchesTabFields = true;
        break;
      }

      case 'addConditionalRule': {
        // Counted before the rule is validated: `validateRanges` expands every
        // range to addresses, and there is no reason to pay for that on a sheet
        // that cannot take another rule whatever the rule says.
        if (rules.length >= MAX_CONDITIONAL_RULES) {
          refuseOp(index, op.type, `This sheet already has the maximum of ${MAX_CONDITIONAL_RULES} rules.`);
        }

        // The parser is the only definition of a usable rule, and on the load
        // path it drops what it cannot use. A blank custom formula is the
        // canonical case: accepted by a naive writer, gone on the next load.
        const rule = validateRuleInput(
          op.rule,
          isObject(op.rule) ? op.rule : {},
          index,
          op.type,
          chargeInspection(index, op.type)
        );

        if (rules.some((existing) => existing.id === rule.id)) {
          // Two rules under one id: `update` and `move` reach the first by
          // `findIndex` while `remove` filters out both, so the new rule is no
          // longer addressable at all. `upsertRegion` refuses the same thing.
          refuseOp(
            index,
            op.type,
            `A rule "${rule.id}" is already on this sheet. Use updateConditionalRule to change it, ` +
              'or give the new rule its own id.'
          );
        }

        rules = [...rules, rule];
        rulesTouched = true;
        break;
      }

      case 'updateConditionalRule': {
        const id = requireId(op.id, index, op.type);
        const at = rules.findIndex((rule) => rule.id === id);
        if (at === -1) {
          refuseOp(index, op.type, `No rule "${id}" on this sheet. Present rules: ${ruleIdList(rules)}.`);
        }
        if (!isObject(op.patch)) {
          refuseOp(index, op.type, 'patch must be an object of rule fields.');
        }

        const patch = op.patch;
        // `id` and `kind` are identity, not settings — matching `updateRule`,
        // which pins both so a patch cannot silently detach a rule from the row
        // being edited. Which also means a patch naming ONLY those two asks for
        // nothing: it would be applied, report success and change not one
        // pixel.
        const mutable = Object.keys(patch).filter((key) => key !== 'id' && key !== 'kind');
        if (mutable.length === 0) {
          refuseOp(
            index,
            op.type,
            'patch changes nothing; id and kind are a rule’s identity and cannot be patched. Name a ' +
              'field such as ranges, format, formula or condition.'
          );
        }

        // Validated as a whole rule, so a patch that widens the ranges clears
        // exactly the same bar a new rule does — otherwise editing is the way
        // around a limit that adding refuses.
        const merged = validateRuleInput(
          { ...rules[at], ...patch, id: rules[at].id, kind: rules[at].kind },
          patch,
          index,
          op.type,
          chargeInspection(index, op.type)
        );

        rules = rules.map((rule, position) => (position === at ? merged : rule));
        rulesTouched = true;
        break;
      }

      case 'removeConditionalRule': {
        const id = requireId(op.id, index, op.type);
        if (!rules.some((rule) => rule.id === id)) {
          // `removeRule` returns the sheet untouched for an unknown id, which
          // over the API is indistinguishable from having removed it.
          refuseOp(index, op.type, `No rule "${id}" on this sheet. Present rules: ${ruleIdList(rules)}.`);
        }
        rules = rules.filter((rule) => rule.id !== id);
        rulesTouched = true;
        break;
      }

      case 'moveConditionalRule': {
        const id = requireId(op.id, index, op.type);
        if (op.direction !== -1 && op.direction !== 1) {
          refuseOp(index, op.type, 'direction must be -1 (earlier) or 1 (later).');
        }

        const at = rules.findIndex((rule) => rule.id === id);
        if (at === -1) {
          refuseOp(index, op.type, `No rule "${id}" on this sheet. Present rules: ${ruleIdList(rules)}.`);
        }

        const target = at + op.direction;
        if (target < 0 || target >= rules.length) {
          // Rule order is precedence, so "already at the end" is a real answer
          // and worth saying rather than reporting a move that did not happen.
          refuseOp(
            index,
            op.type,
            `Rule "${id}" is already ${op.direction === -1 ? 'first' : 'last'}; there is nowhere to move it.`
          );
        }

        const next = [...rules];
        [next[at], next[target]] = [next[target], next[at]];
        rules = next;
        rulesTouched = true;
        break;
      }

      case 'clearConditionalRules': {
        // Allowed on a sheet that already has none, unlike removing an id that
        // is not there. The difference is what the caller asserted: a clear
        // names no target and so cannot be wrong about one, while a remove
        // names an id and is telling us something false about the sheet.
        rules = [];
        rulesTouched = true;
        break;
      }

      case 'setRegions': {
        if (!Array.isArray(op.regions)) {
          refuseOp(index, op.type, 'regions must be an array.');
        }
        if (op.regions.length > MAX_REGIONS) {
          refuseOp(
            index,
            op.type,
            `A sheet can hold at most ${MAX_REGIONS} regions; got ${op.regions.length}.`
          );
        }

        const next: SheetRegion[] = [];
        const seen = new Set<string>();
        op.regions.forEach((value: unknown, position: number) => {
          const region = validateRegionInput(value, index, op.type, `regions[${position}]`);
          if (seen.has(region.id)) {
            // `parseRegions` keeps the first and drops the rest, so a duplicate
            // id is a region silently lost between write and read.
            refuseOp(index, op.type, `Two regions share the id "${region.id}".`);
          }
          seen.add(region.id);
          next.push(region);
        });

        regions = next;
        regionsTouched = true;
        break;
      }

      case 'upsertRegion': {
        const region = validateRegionInput(op.region, index, op.type, 'region');

        const at = regions.findIndex((existing) => existing.id === region.id);
        if (at === -1) {
          if (regions.length >= MAX_REGIONS) {
            refuseOp(index, op.type, `This sheet already has the maximum of ${MAX_REGIONS} regions.`);
          }
          regions = [...regions, region];
        } else {
          regions = regions.map((existing, position) => (position === at ? region : existing));
        }
        regionsTouched = true;
        break;
      }

      case 'removeRegion': {
        const id = requireId(op.id, index, op.type);
        if (!regions.some((region) => region.id === id)) {
          refuseOp(index, op.type, `No region "${id}" on this sheet. Present regions: ${regionIdList(regions)}.`);
        }
        regions = regions.filter((region) => region.id !== id);
        regionsTouched = true;
        break;
      }

      default:
        refuse(`Op ${index}: unknown op type "${String(op.type)}".`, index);
    }
  });

  if (rulesTouched) {
    // The aggregate ceiling `MAX_CONDITIONAL_TOTAL_CELLS` is spent by
    // `expandRangesWithinBudget` and then *broken out of*, silently: rules past
    // the budget simply stop contributing at render time. Individually legal
    // rules can sum past it, so a write that would land there is refused while
    // there is still someone to tell.
    const totalCells = (list: readonly ConditionalRule[]): number => {
      let cells = 0;
      for (const rule of list) {
        for (const range of rule.ranges) cells += conditionalCellsOfRange(range);
      }
      return cells;
    };

    const before = totalCells(tab.conditionalFormats ?? []);
    const after = totalCells(rules);

    // Over the ceiling AND worse than it was. A sheet can already be past this
    // limit — the panel's `addRule` enforces the per-rule and rule-count caps
    // but not the aggregate — and refusing every write on such a sheet would
    // leave it unrepairable: removing a rule from it reduces the skipped render
    // work and would still have been rejected for not fixing everything at
    // once. A write that does not make matters worse is always allowed.
    if (after > MAX_CONDITIONAL_TOTAL_CELLS && after > before) {
      refuse(
        `Those rules cover ${after.toLocaleString()} cells in total, over the sheet-wide limit of ` +
          `${MAX_CONDITIONAL_TOTAL_CELLS.toLocaleString()}. Rules past the limit are silently skipped when ` +
          'the sheet renders, so narrow the ranges rather than adding more. (A write that lowers the ' +
          'total is accepted even while it is still over.)'
      );
    }

    // Round-trip detector. The plan is only as good as what survives being
    // stored and read back, and every cap here was written against a drop mode
    // someone already found the hard way. Re-parsing the result catches the
    // ones nobody has found yet — including caps added to the parsers later,
    // which this will notice without being taught about them.
    const stored = parseConditionalRules(rules) ?? [];
    if (stored.length < rules.length) {
      refuse(
        `${rules.length - stored.length} of the resulting ${rules.length} rules would be dropped when ` +
          'the sheet is read back. Nothing was applied.'
      );
    }

    steps.push({ type: 'setConditionalRules', rules });
    touchesTabFields = true;
  }

  if (regionsTouched) {
    const stored = parseRegions(regions) ?? [];
    if (stored.length < regions.length) {
      refuse(
        `${regions.length - stored.length} of the resulting ${regions.length} regions would be dropped ` +
          'when the sheet is read back. Nothing was applied.'
      );
    }

    steps.push({ type: 'setRegions', regions });
    touchesTabFields = true;
  }

  return { steps, rows, touchesTabFields, conditionalFormats: rules, regions };
}
