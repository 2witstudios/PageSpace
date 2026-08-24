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

/** Every address of an `A1:B2` range, or of a bare `A1`. Invalid ranges yield none. */
export function addressesOfRange(range: string): string[] {
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

  const addresses: string[] = [];
  const rowStart = Math.min(start.row, end.row);
  const rowEnd = Math.max(start.row, end.row);
  const columnStart = Math.min(start.column, end.column);
  const columnEnd = Math.max(start.column, end.column);

  for (let row = rowStart; row <= rowEnd; row++) {
    for (let column = columnStart; column <= columnEnd; column++) {
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

  for (const rule of rules) {
    const addresses = rule.ranges.flatMap((range) => addressesOfRange(range));
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

      case 'formula': {
        for (const range of rule.ranges) {
          const anchor = rangeAnchor(range);
          if (!anchor) continue;

          for (const address of addressesOfRange(range)) {
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
          const color = rule.mid
            ? position <= 0.5
              ? mixColors(rule.min.color ?? '', rule.mid.color ?? '', position * 2)
              : mixColors(rule.mid.color ?? '', rule.max.color ?? '', (position - 0.5) * 2)
            : mixColors(rule.min.color ?? '', rule.max.color ?? '', position);

          if (color) contribute(address, { background: color });
        }
        break;
      }

      case 'dataBar': {
        const sorted = numbersIn(addresses, context).sort((a, b) => a - b);
        if (sorted.length === 0) break;

        const low = Math.min(0, anchorValue(rule.min, sorted, 'min'));
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
