/**
 * @module @pagespace/lib/sheets/conditional
 * @description Conditional formatting: rules that derive a cell's presentation
 * from its value.
 *
 * Pure. The evaluator supplies values, error state and a formula evaluator
 * through `ConditionalContext`, which is what keeps this module testable
 * without an engine and out of an import cycle with one.
 *
 * Precedence is column default < conditional < explicit cell format. Note that
 * Excel and Google Sheets do the opposite — there, a conditional rule overrides
 * a manually applied fill. The choice here is that a colour someone deliberately
 * set on a cell is not silently overruled by a rule; it is worth revisiting when
 * import fidelity lands, because a workbook authored in Excel will render
 * differently under this precedence.
 */

import type { CellFormat, SheetPrimitive } from './types';
import { parseCellFormat } from './format';
import { adjustFormulaReferences, decodeCellAddress, encodeCellAddress } from './address';

/** Comparisons a single-colour rule can make against a cell's value. */
export type ConditionalOperator =
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'equal'
  | 'notEqual'
  | 'between'
  | 'notBetween'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'isError';

export interface ConditionalCondition {
  operator: ConditionalOperator;
  /** Compared against the cell. Numeric operators parse it as a number. */
  value?: string;
  /** Upper bound, for `between` / `notBetween`. */
  value2?: string;
}

/** Where a colour-scale or data-bar anchor sits. */
export interface ScaleAnchor {
  type: 'min' | 'max' | 'number' | 'percent' | 'percentile';
  /** Required for `number`, `percent` and `percentile`. */
  value?: number;
  /** `#rrggbb`. Unused by a data bar's bounds. */
  color?: string;
}

interface RuleBase {
  id: string;
  /** A1 ranges the rule covers, e.g. `["B2:D10"]`. */
  ranges: string[];
}

export interface ConditionalCellRule extends RuleBase {
  kind: 'cell';
  condition: ConditionalCondition;
  format: CellFormat;
}

export interface ConditionalFormulaRule extends RuleBase {
  kind: 'formula';
  /**
   * Evaluated per cell, with relative references shifted from the range's
   * top-left — the same anchoring a paste uses.
   */
  formula: string;
  format: CellFormat;
}

export interface ConditionalColorScaleRule extends RuleBase {
  kind: 'colorScale';
  min: ScaleAnchor;
  mid?: ScaleAnchor;
  max: ScaleAnchor;
}

export interface ConditionalDataBarRule extends RuleBase {
  kind: 'dataBar';
  color: string;
  min?: ScaleAnchor;
  max?: ScaleAnchor;
}

export type ConditionalRule =
  | ConditionalCellRule
  | ConditionalFormulaRule
  | ConditionalColorScaleRule
  | ConditionalDataBarRule;

/**
 * A data bar is drawn behind the value as a proportional fill, which no
 * `CellFormat` field can express — it is a render-layer concern, so it travels
 * separately rather than being forced into one.
 */
export interface DataBarFill {
  color: string;
  /** 0–1 of the cell's width. */
  fraction: number;
}

export interface ConditionalResult {
  formats: Record<string, CellFormat>;
  bars: Record<string, DataBarFill>;
}

export interface ConditionalContext {
  /** The cell's evaluated value; `''` for an empty cell. */
  valueAt: (address: string) => SheetPrimitive;
  /** Whether the cell evaluated to an error. */
  isError: (address: string) => boolean;
  /**
   * Evaluate a formula in the sheet's context. Supplied by the engine so this
   * module does not import it.
   */
  evaluateFormula: (formula: string) => SheetPrimitive;
}

const EMPTY: ConditionalResult = { formats: {}, bars: {} };

/**
 * The most cells one rule range may cover.
 *
 * Addresses go up to ZZZ5000000, so `A1:ZZZ5000000` is a *valid* range naming
 * roughly ninety billion cells. Expanding one would hang the process, and rules
 * are stored as jsonb that the API can write — so the ceiling is enforced here,
 * where every caller goes through, rather than trusted not to be reached.
 *
 * Generous against real use: a rule over a 10,000-row block of 26 columns is
 * 260,000 cells. A range beyond this formats nothing, which is the same
 * treatment any other unusable range gets.
 */
export const MAX_CONDITIONAL_RANGE_CELLS = 500_000;

/**
 * The most rules a sheet's conditional-format list may hold.
 *
 * `MAX_CONDITIONAL_RANGE_CELLS` bounds one range; nothing bounded the rule
 * count itself, and rules are stored as API-writable jsonb — so a write with
 * thousands of rules (each individually under the per-range cap) passed
 * through untouched and made every render/save re-walk all of them. Enforced
 * at the parse boundary (`parseConditionalRules`), where every stored value
 * — API write or load — passes through.
 *
 * That "API write or load" is deliberate, not incidental: bounding
 * evaluation work requires the cap to apply everywhere a stored value is
 * parsed, not only on fresh writes. The cost is the same one
 * `MAX_CONDITIONAL_RANGE_CELLS` already accepts for an individually
 * oversized range — a sheet that already has more rules than the cap (not
 * achievable through this codebase today, since conditional formatting
 * shipped with no rule-count limit at all until this constant existed) would
 * have the excess silently dropped on load, and a subsequent save persists
 * that truncation. Generous enough (200) that reaching it is not a realistic
 * accident.
 */
export const MAX_CONDITIONAL_RULES = 200;

/**
 * The most range entries one rule's `ranges` array may hold.
 *
 * `expandRangesWithinBudget` stops as soon as the cell budget is spent — but
 * an invalid or individually-oversized range (e.g. `A1:A500001`, one past
 * `MAX_CONDITIONAL_RANGE_CELLS`) contributes zero cells via `addressesOfRange`,
 * so the budget never decreases for it. A `ranges` array padded with an
 * unbounded number of such entries would still cost real, unbounded CPU —
 * one `addressesOfRange` call (parse, decode, bounds-check) per entry — with
 * the per-cell budget never tripping. Capped at the same parse boundary as
 * `MAX_CONDITIONAL_RULES`, in `readRanges`, so this can never reach the
 * evaluator at all. Generous against real use: a rule needing more than a
 * thousand disjoint ranges is not a realistic layout.
 */
export const MAX_CONDITIONAL_RANGES_PER_RULE = 1_000;

/**
 * The most cells conditional-format evaluation may cover in total, across
 * every rule and every range of a sheet combined.
 *
 * `MAX_CONDITIONAL_RANGE_CELLS` only bounds one range at a time; a rule list
 * with many rules, or many ranges per rule, each individually under that cap,
 * could still sum to unbounded work — and a `formula` rule shifts, tokenizes,
 * parses and evaluates a formula per covered cell, making that work
 * expensive per cell rather than cheap. This is the aggregate ceiling that
 * catches what the per-range cap alone cannot.
 */
export const MAX_CONDITIONAL_TOTAL_CELLS = 2_000_000;

/**
 * Expand a list of ranges to addresses, one range at a time, never
 * materializing more than `remainingBudget` combined.
 *
 * `rule.ranges` is API-writable jsonb with no cap on entry count: a rule can
 * hold an unbounded number of ranges that are each individually valid and
 * under `MAX_CONDITIONAL_RANGE_CELLS` on their own. Expanding all of them
 * with `flatMap` before applying an aggregate budget via `.slice()` would
 * still allocate unbounded memory — the slice only trims the *result*, after
 * the allocation that was supposed to be prevented already happened.
 * Walking ranges one at a time, and asking `addressesOfRange` to stop at the
 * remaining budget rather than enumerating a whole range and slicing it down
 * afterward, keeps the true peak at `remainingBudget` — not `remainingBudget`
 * plus whatever one oversized range would have enumerated before trimming.
 */
export function expandRangesWithinBudget(
  ranges: readonly string[],
  remainingBudget: number
): { addresses: string[]; consumed: number } {
  // `.concat()`, not `.push(...rangeAddresses)`: spreading a few-hundred-
  // thousand-element array as call arguments blows the engine's argument-
  // count limit ("Maximum call stack size exceeded") well before it reaches
  // `MAX_CONDITIONAL_RANGE_CELLS`.
  let addresses: string[] = [];
  let consumed = 0;

  for (const range of ranges) {
    if (consumed >= remainingBudget) break;

    const rangeAddresses = addressesOfRange(range, remainingBudget - consumed);
    if (rangeAddresses.length === 0) continue;

    addresses = addresses.concat(rangeAddresses);
    consumed += rangeAddresses.length;
  }

  return { addresses, consumed };
}

/**
 * Every address of an `A1:B2` range, or of a bare `A1`. Invalid ranges yield
 * none.
 *
 * `maxCount` stops enumeration early — after that many addresses, not after
 * building the whole range and trimming it — so a caller with a small
 * remaining budget can ask for a small array outright instead of paying for
 * a large one it will immediately discard most of. It only ever narrows: a
 * range over `MAX_CONDITIONAL_RANGE_CELLS` is still rejected wholesale
 * regardless of `maxCount`, unchanged from before this parameter existed.
 */
export function addressesOfRange(range: string, maxCount: number = MAX_CONDITIONAL_RANGE_CELLS): string[] {
  const normalized = range.trim().toUpperCase();
  const [rawStart, rawEnd, ...extra] = normalized.split(':');
  if (!rawStart || extra.length > 0) return [];
  // A colon means the author meant a range. `A1:` is a truncated one, and
  // quietly formatting the single cell `A1` instead is worse than doing
  // nothing — it looks like the rule works.
  if (normalized.includes(':') && !rawEnd) return [];

  let start: { row: number; column: number };
  let end: { row: number; column: number };
  try {
    start = decodeCellAddress(rawStart);
    end = rawEnd ? decodeCellAddress(rawEnd) : start;
  } catch {
    return [];
  }

  // `decodeCellAddress` accepts `A0` and returns row -1, because rows are
  // 1-based on the way in. Expanding that calls `encodeCellAddress(-1, …)`,
  // which throws — so one malformed stored rule would take the whole sheet's
  // evaluation and serialization down with it, instead of being ignored the way
  // this function promises.
  if (start.row < 0 || start.column < 0 || end.row < 0 || end.column < 0) return [];

  const rowStart = Math.min(start.row, end.row);
  const rowEnd = Math.max(start.row, end.row);
  const columnStart = Math.min(start.column, end.column);
  const columnEnd = Math.max(start.column, end.column);

  // Counted before allocating: the point is not to build the array at all.
  if ((rowEnd - rowStart + 1) * (columnEnd - columnStart + 1) > MAX_CONDITIONAL_RANGE_CELLS) {
    return [];
  }

  const addresses: string[] = [];
  outer: for (let row = rowStart; row <= rowEnd; row++) {
    for (let column = columnStart; column <= columnEnd; column++) {
      if (addresses.length >= maxCount) break outer;
      addresses.push(encodeCellAddress(row, column));
    }
  }
  return addresses;
}

/** The top-left of a range, which relative formula references anchor to. */
export function rangeAnchor(range: string): { row: number; column: number } | null {
  const normalized = range.trim().toUpperCase();
  const [rawStart, rawEnd, ...extra] = normalized.split(':');
  if (!rawStart || extra.length > 0) return null;
  if (normalized.includes(':') && !rawEnd) return null;
  try {
    const start = decodeCellAddress(rawStart);
    const end = rawEnd ? decodeCellAddress(rawEnd) : start;
    if (start.row < 0 || start.column < 0 || end.row < 0 || end.column < 0) return null;
    return { row: Math.min(start.row, end.row), column: Math.min(start.column, end.column) };
  } catch {
    return null;
  }
}

const asNumber = (value: SheetPrimitive): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === '') return null;
  const parsed = Number(String(value).trim());
  return String(value).trim() !== '' && Number.isFinite(parsed) ? parsed : null;
};

// `''` is already covered by the string branch — `SheetPrimitive` includes it
// as a string literal, so there is no separate empty case to handle.
const asText = (value: SheetPrimitive): string =>
  typeof value === 'string' ? value : String(value);

/** Whether a cell satisfies a single-colour rule's condition. */
export function matchesCondition(
  value: SheetPrimitive,
  isError: boolean,
  condition: ConditionalCondition
): boolean {
  const { operator } = condition;

  if (operator === 'isError') return isError;
  // Every other operator describes the value, and an error cell has none —
  // treating `#ERROR` as text would make "contains 'E'" light up broken cells.
  if (isError) return false;

  if (operator === 'isEmpty') return value === '';
  if (operator === 'isNotEmpty') return value !== '';

  const text = asText(value);
  const lowerText = text.toLowerCase();
  const compareText = (condition.value ?? '').toLowerCase();

  switch (operator) {
    case 'contains':
      return compareText !== '' && lowerText.includes(compareText);
    case 'notContains':
      return compareText === '' || !lowerText.includes(compareText);
    case 'startsWith':
      return compareText !== '' && lowerText.startsWith(compareText);
    case 'endsWith':
      return compareText !== '' && lowerText.endsWith(compareText);
    default:
      break;
  }

  // Numeric comparisons. A non-numeric cell simply does not match, rather than
  // coercing to NaN and comparing false in a way that is hard to reason about.
  const left = asNumber(value);
  const right = condition.value === undefined ? null : asNumber(condition.value);

  if (operator === 'equal' || operator === 'notEqual') {
    // Equality falls back to text so `= "done"` works on a status column.
    const equal =
      left !== null && right !== null ? left === right : lowerText === compareText;
    return operator === 'equal' ? equal : !equal;
  }

  if (left === null || right === null) return false;

  switch (operator) {
    case 'greaterThan':
      return left > right;
    case 'greaterThanOrEqual':
      return left >= right;
    case 'lessThan':
      return left < right;
    case 'lessThanOrEqual':
      return left <= right;
    case 'between':
    case 'notBetween': {
      const upper = condition.value2 === undefined ? null : asNumber(condition.value2);
      if (upper === null) return false;
      const low = Math.min(right, upper);
      const high = Math.max(right, upper);
      const within = left >= low && left <= high;
      return operator === 'between' ? within : !within;
    }
    default:
      return false;
  }
}

/** Truthiness of a formula rule's result, matching the engine's own notion. */
const isTruthy = (value: SheetPrimitive): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (value === '') return false;
  return String(value).trim().toUpperCase() === 'TRUE';
};

/** Numeric values present in a rule's ranges, for scale anchoring. */
const numbersIn = (addresses: string[], context: ConditionalContext): number[] => {
  const numbers: number[] = [];
  for (const address of addresses) {
    if (context.isError(address)) continue;
    const parsed = asNumber(context.valueAt(address));
    if (parsed !== null) numbers.push(parsed);
  }
  return numbers;
};

/** The nth percentile of a sorted list, linearly interpolated. */
const percentileOf = (sorted: number[], percent: number): number => {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const position = (Math.min(100, Math.max(0, percent)) / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

/** Resolve an anchor to a concrete value against the range's numbers. */
const anchorValue = (
  anchor: ScaleAnchor | undefined,
  sorted: number[],
  fallback: 'min' | 'max'
): number => {
  const lowest = sorted[0] ?? 0;
  const highest = sorted[sorted.length - 1] ?? 0;
  const type = anchor?.type ?? fallback;

  switch (type) {
    case 'min':
      return lowest;
    case 'max':
      return highest;
    case 'number':
      return anchor?.value ?? (fallback === 'min' ? lowest : highest);
    case 'percent': {
      const percent = Math.min(100, Math.max(0, anchor?.value ?? 0)) / 100;
      return lowest + (highest - lowest) * percent;
    }
    case 'percentile':
      return percentileOf(sorted, anchor?.value ?? 0);
    default:
      return fallback === 'min' ? lowest : highest;
  }
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const parseChannels = (hex: string): [number, number, number] | null => {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const digits = match[1];
  return [
    parseInt(digits.slice(0, 2), 16),
    parseInt(digits.slice(2, 4), 16),
    parseInt(digits.slice(4, 6), 16),
  ];
};

const toHex = (channels: [number, number, number]): string =>
  `#${channels.map((c) => Math.round(clamp01(c / 255) * 255).toString(16).padStart(2, '0')).join('')}`;

/** Linear interpolation between two `#rrggbb` colours. */
export function mixColors(from: string, to: string, amount: number): string | null {
  const a = parseChannels(from);
  const b = parseChannels(to);
  if (!a || !b) return null;
  const t = clamp01(amount);
  return toHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

/**
 * Blend a position through a three-colour scale whose midpoint sits at
 * `midPosition`.
 *
 * Each side is interpolated across its own span, so a midpoint anchored at 10
 * on a 0..100 scale really does put its colour at 10. Only two inputs divide by
 * zero — a value sitting exactly on a midpoint pinned to either end — and each
 * resolves to the midpoint colour, which is the limit approached from the side
 * that still has width.
 */
function mixThroughMidpoint(
  rule: ConditionalColorScaleRule,
  position: number,
  midPosition: number
): string | null {
  const minColor = rule.min.color ?? '';
  const midColor = rule.mid?.color ?? '';
  const maxColor = rule.max.color ?? '';

  if (position <= midPosition) {
    return mixColors(minColor, midColor, midPosition === 0 ? 1 : position / midPosition);
  }
  return mixColors(midColor, maxColor, midPosition >= 1 ? 1 : (position - midPosition) / (1 - midPosition));
}

/**
 * Apply rules to a sheet, in order.
 *
 * Later rules layer over earlier ones for the fields they set, which is how
 * Google Sheets stacks them — a rule that only sets a text colour leaves an
 * earlier rule's fill intact. Nothing here reads or writes the sheet; the
 * caller merges `formats` beneath each cell's explicit format.
 */
export function evaluateConditionalFormats(
  rules: readonly ConditionalRule[],
  context: ConditionalContext
): ConditionalResult {
  if (rules.length === 0) return EMPTY;

  const formats: Record<string, CellFormat> = {};
  const bars: Record<string, DataBarFill> = {};

  const contribute = (address: string, format: CellFormat) => {
    formats[address] = { ...(formats[address] ?? {}), ...format };
  };

  // Aggregate budget across every rule and range combined — see
  // `MAX_CONDITIONAL_TOTAL_CELLS`. Decremented as ranges are consumed below;
  // once it hits zero, remaining rules/ranges contribute nothing further,
  // the same treatment an individually-oversized range already gets.
  let remainingCellBudget = MAX_CONDITIONAL_TOTAL_CELLS;

  for (const rule of rules) {
    if (remainingCellBudget <= 0) break;

    // `formula` needs each range's own anchor for relative-reference shifting,
    // so it walks `rule.ranges` itself below rather than through the shared
    // expansion — which also means it never allocates the address list this
    // computes, since it wouldn't use it.
    if (rule.kind === 'formula') {
      for (const range of rule.ranges) {
        if (remainingCellBudget <= 0) break;

        const anchor = rangeAnchor(range);
        if (!anchor) continue;

        const rangeAddresses = addressesOfRange(range, remainingCellBudget);
        remainingCellBudget -= rangeAddresses.length;

        for (const address of rangeAddresses) {
          const { row, column } = decodeCellAddress(address);
          // Relative references shift from the range's top-left, so one rule
          // written against the first cell reads correctly for all of them.
          const shifted = adjustFormulaReferences(
            rule.formula,
            row - anchor.row,
            column - anchor.column
          );
          let result: SheetPrimitive;
          try {
            result = context.evaluateFormula(shifted);
          } catch {
            // A rule that cannot be evaluated must not take the sheet down
            // with it; it simply does not match.
            continue;
          }
          if (isTruthy(result)) contribute(address, rule.format);
        }
      }
      continue;
    }

    // Ranges are expanded one at a time, stopping as soon as the budget is
    // spent — see `expandRangesWithinBudget`. A rule may hold an unbounded
    // number of ranges (jsonb, no cap on array length), each individually
    // valid and under `MAX_CONDITIONAL_RANGE_CELLS` on its own; flat-mapping
    // all of them before slicing to the budget would still allocate
    // unbounded memory before the cap ever took effect.
    const { addresses, consumed } = expandRangesWithinBudget(rule.ranges, remainingCellBudget);
    remainingCellBudget -= consumed;
    if (addresses.length === 0) continue;

    switch (rule.kind) {
      case 'cell': {
        for (const address of addresses) {
          if (matchesCondition(context.valueAt(address), context.isError(address), rule.condition)) {
            contribute(address, rule.format);
          }
        }
        break;
      }

      case 'colorScale': {
        const sorted = numbersIn(addresses, context).sort((a, b) => a - b);
        if (sorted.length === 0) break;

        const low = anchorValue(rule.min, sorted, 'min');
        const high = anchorValue(rule.max, sorted, 'max');
        const span = high - low;

        for (const address of addresses) {
          if (context.isError(address)) continue;
          const value = asNumber(context.valueAt(address));
          if (value === null) continue;

          // A flat range has no gradient to place a value on; every cell takes
          // the low colour rather than dividing by zero.
          const position = span === 0 ? 0 : clamp01((value - low) / span);

          // The midpoint sits where its own anchor puts it. Interpolating
          // around a hardcoded 0.5 would ignore `number`, `percent` and any
          // non-median `percentile`, so a midpoint configured at 10 on a 0..100
          // scale would render its colour at 50.
          const color = rule.mid
            ? mixThroughMidpoint(rule, position, span === 0
                ? 0
                : clamp01((anchorValue(rule.mid, sorted, 'min') - low) / span))
            : mixColors(rule.min.color ?? '', rule.max.color ?? '', position);

          if (color) contribute(address, { background: color });
        }
        break;
      }

      case 'dataBar': {
        const sorted = numbersIn(addresses, context).sort((a, b) => a - b);
        if (sorted.length === 0) break;

        // Excel's baseline-at-zero default only applies to the auto anchor —
        // an explicit anchor (e.g. a positive `number`/`percent`/`percentile`
        // min) must be honored as the user configured it, not forced ≤0.
        const low =
          rule.min && rule.min.type !== 'min'
            ? anchorValue(rule.min, sorted, 'min')
            : Math.min(0, anchorValue(rule.min, sorted, 'min'));
        const high = anchorValue(rule.max, sorted, 'max');
        const span = high - low;

        for (const address of addresses) {
          if (context.isError(address)) continue;
          const value = asNumber(context.valueAt(address));
          if (value === null) continue;
          bars[address] = {
            color: rule.color,
            fraction: span === 0 ? 0 : clamp01((value - low) / span),
          };
        }
        break;
      }
    }
  }

  return { formats, bars };
}


// ---- Parsing stored rules ------------------------------------------------

const OPERATORS = new Set<ConditionalOperator>([
  'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual',
  'equal', 'notEqual', 'between', 'notBetween',
  'contains', 'notContains', 'startsWith', 'endsWith',
  'isEmpty', 'isNotEmpty', 'isError',
]);

const ANCHOR_TYPES = new Set(['min', 'max', 'number', 'percent', 'percentile']);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readRanges = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  // Sliced before filtering, not after: the point is to bound how many
  // entries get inspected at all, not just how many end up valid.
  const ranges = value
    .slice(0, MAX_CONDITIONAL_RANGES_PER_RULE)
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
  return ranges.length > 0 ? ranges : null;
};

const readAnchor = (value: unknown): ScaleAnchor | null => {
  if (!isObject(value)) return null;
  const type = value.type;
  if (typeof type !== 'string' || !ANCHOR_TYPES.has(type)) return null;

  const anchor: ScaleAnchor = { type: type as ScaleAnchor['type'] };
  if (typeof value.value === 'number' && Number.isFinite(value.value)) anchor.value = value.value;
  if (typeof value.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.color)) {
    anchor.color = value.color.toLowerCase();
  }
  // A scale anchor without a colour cannot be interpolated against.
  return anchor;
};

/**
 * Validate one stored rule.
 *
 * Anything whose core shape is unusable is dropped rather than rendered: a rule
 * is presentation derived from user data, and a malformed one would either
 * paint nothing or paint nonsense across a range. Unknown *fields* within an
 * otherwise valid rule are left alone, so a rule written by a newer build
 * survives a load/save cycle here.
 */
export function parseConditionalRule(value: unknown): ConditionalRule | null {
  if (!isObject(value)) return null;

  const id = typeof value.id === 'string' && value.id !== '' ? value.id : null;
  const ranges = readRanges(value.ranges);
  if (!id || !ranges) return null;

  switch (value.kind) {
    case 'cell': {
      if (!isObject(value.condition)) return null;
      const operator = value.condition.operator;
      if (typeof operator !== 'string' || !OPERATORS.has(operator as ConditionalOperator)) return null;

      const condition: ConditionalCondition = { operator: operator as ConditionalOperator };
      if (typeof value.condition.value === 'string') condition.value = value.condition.value;
      if (typeof value.condition.value2 === 'string') condition.value2 = value.condition.value2;

      const format = parseCellFormat(value.format);
      if (!format) return null;
      return { ...value, id, kind: 'cell', ranges, condition, format };
    }

    case 'formula': {
      if (typeof value.formula !== 'string' || value.formula.trim() === '') return null;
      const format = parseCellFormat(value.format);
      if (!format) return null;
      return { ...value, id, kind: 'formula', ranges, formula: value.formula, format };
    }

    case 'colorScale': {
      const min = readAnchor(value.min);
      const max = readAnchor(value.max);
      // Without both end colours there is no gradient to place a value on.
      if (!min?.color || !max?.color) return null;
      const mid = readAnchor(value.mid);
      return {
        ...value,
        id,
        kind: 'colorScale',
        ranges,
        min,
        max,
        ...(mid?.color ? { mid } : {}),
      };
    }

    case 'dataBar': {
      if (typeof value.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value.color)) return null;
      const min = readAnchor(value.min);
      const max = readAnchor(value.max);
      return {
        ...value,
        id,
        kind: 'dataBar',
        ranges,
        color: value.color.toLowerCase(),
        ...(min ? { min } : {}),
        ...(max ? { max } : {}),
      };
    }

    default:
      return null;
  }
}

/**
 * Read a stored rule collection back into an ordered list.
 *
 * Accepts either an array or the numerically-keyed map the TOML bag stores,
 * because the bag holds objects and rule order is load-bearing — later rules
 * layer over earlier ones.
 */
export function parseConditionalRules(value: unknown): ConditionalRule[] | undefined {
  let entries: unknown[];

  if (Array.isArray(value)) {
    entries = value;
  } else if (isObject(value)) {
    entries = Object.keys(value)
      .map((key) => ({ key, index: Number(key) }))
      .filter(({ index }) => Number.isFinite(index))
      .sort((a, b) => a.index - b.index)
      .map(({ key }) => (value as Record<string, unknown>)[key]);
  } else {
    return undefined;
  }

  // Collected incrementally and capped here — the API write door every
  // stored rule set passes through — rather than parsing every entry before
  // slicing: `entries` can be unbounded (API-writable jsonb), and parsing
  // one is real work. Stops as soon as `MAX_CONDITIONAL_RULES` valid rules
  // are collected instead of parsing the rest for nothing.
  const rules: ConditionalRule[] = [];
  for (const entry of entries) {
    if (rules.length >= MAX_CONDITIONAL_RULES) break;
    const rule = parseConditionalRule(entry);
    if (rule) rules.push(rule);
  }

  return rules.length > 0 ? rules : undefined;
}
