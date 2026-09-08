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
  addressesOfRange,
  parseConditionalRule,
  parseConditionalRules,
  type ConditionalRule,
} from './conditional';
import { validateRanges } from './conditional-ops';
import { CELL_FORMAT_FIELDS, cellFormatSchema } from './format';
import {
  MAX_COLUMN_WIDTH,
  MAX_ROW_HEIGHT,
  MIN_COLUMN_WIDTH,
  MIN_ROW_HEIGHT,
} from './format-ops';
import { MAX_REGIONS, parseRegion, parseRegions, type SheetRegion } from './regions';
import type { CellFormat } from './types';

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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keys that would reach a prototype rather than a property once merged. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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
function validateCellFormatPatch(patch: unknown, index: number, type: string): CellFormat {
  if (!isObject(patch)) {
    return refuseOp(index, type, 'patch must be an object of format fields.');
  }

  const keys = Object.keys(patch);
  if (keys.length === 0) {
    // Applying this would succeed and change nothing, which is the failure mode
    // hardest to notice from the outside.
    return refuseOp(index, type, 'patch has no fields; name at least one, such as {"bold": true}.');
  }

  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) {
      return refuseOp(index, type, `"${key}" is not a format field.`);
    }
    if (!CELL_FORMAT_FIELDS.has(key)) {
      return refuseOp(
        index,
        type,
        `"${key}" is not a format field. Known fields: ${[...CELL_FORMAT_FIELDS].join(', ')}.`
      );
    }
  }

  const result = cellFormatSchema.safeParse(patch);
  if (!result.success) {
    const issue = result.error.issues[0];
    // Rooted at `patch` unconditionally: the path is never empty here — the
    // object and key checks above have already run — and a conditional root
    // would be a branch no input can take.
    return refuseOp(index, type, `${['patch', ...issue.path].join('.')}: ${issue.message}`);
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

  const requireId = (id: unknown, index: number, type: string): string => {
    if (typeof id !== 'string' || id === '') {
      return refuseOp(index, type, 'id must be a non-empty string.');
    }
    return id;
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
        const addresses = resolveRange(op.range, index, op.type);
        steps.push({
          type: 'setCellFormat',
          addresses,
          patch: validateCellFormatPatch(op.patch, index, op.type),
        });
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
        // 1-based on the wire, as everywhere a row is named in A1 terms.
        if (typeof row !== 'number' || !Number.isInteger(row) || row < 1 || row > MAX_ADDRESSABLE_ROW) {
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
        const rule = parseConditionalRule(op.rule);
        if (!rule) {
          // The parser is the only definition of a usable rule, and it drops
          // what it cannot use. A blank custom formula is the canonical case:
          // accepted by a naive writer, gone on the next load.
          refuseOp(
            index,
            op.type,
            'That is not a rule this sheet can store. A rule needs an id, at least one range, and a ' +
              'kind of cell, formula, colorScale or dataBar — a formula rule needs a non-empty formula, ' +
              'and a cell rule a format with at least one valid field.'
          );
        }
        if (rules.length >= MAX_CONDITIONAL_RULES) {
          refuseOp(index, op.type, `This sheet already has the maximum of ${MAX_CONDITIONAL_RULES} rules.`);
        }
        const ranges = validateRanges(rule.ranges);
        if (!ranges.ok) refuseOp(index, op.type, ranges.reason);

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

        const patch = op.patch as Record<string, unknown>;
        // A patch that widens the ranges has to clear the same bar as a new
        // rule, or editing is the way around a limit that adding refuses.
        if (Array.isArray(patch.ranges)) {
          const ranges = validateRanges(patch.ranges.filter((r): r is string => typeof r === 'string'));
          if (!ranges.ok) refuseOp(index, op.type, ranges.reason);
        }

        // `id` and `kind` are identity, not settings — matching `updateRule`,
        // which pins both so a patch cannot silently detach a rule from the row
        // being edited.
        const merged = parseConditionalRule({
          ...rules[at],
          ...patch,
          id: rules[at].id,
          kind: rules[at].kind,
        });
        if (!merged) {
          refuseOp(index, op.type, `That patch leaves rule "${id}" in a state this sheet cannot store.`);
        }

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
          const region = parseRegion(value);
          if (!region) {
            refuseOp(
              index,
              op.type,
              `regions[${position}] is not a region this sheet can store. A region needs an id and a ` +
                'range such as "A1:F" (an omitted row end means "to the end of the sheet").'
            );
          }
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
        const region = parseRegion(op.region);
        if (!region) {
          refuseOp(
            index,
            op.type,
            'That is not a region this sheet can store. A region needs an id and a range such as ' +
              '"A1:F" (an omitted row end means "to the end of the sheet").'
          );
        }

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
    let total = 0;
    for (const rule of rules) {
      for (const range of rule.ranges) total += conditionalCellsOfRange(range);
    }
    if (total > MAX_CONDITIONAL_TOTAL_CELLS) {
      refuse(
        `Those rules cover ${total.toLocaleString()} cells in total, over the sheet-wide limit of ` +
          `${MAX_CONDITIONAL_TOTAL_CELLS.toLocaleString()}. Rules past the limit are silently skipped when ` +
          'the sheet renders, so narrow the ranges rather than adding more.'
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
