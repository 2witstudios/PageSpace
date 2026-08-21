/**
 * Column shapes for the sheet tables' jsonb payloads.
 *
 * These live here rather than in `@pagespace/lib` because the dependency runs
 * the other way — `lib` depends on `db`, so `db` cannot import the sheet types
 * from it. To stop the two definitions drifting silently, `lib` asserts at
 * compile time that its `CellFormat` and these are mutually assignable; see
 * `packages/lib/src/sheets/storage-contract.ts`.
 */

export type StoredNumberFormatKind =
  | 'auto'
  | 'plain'
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'time'
  | 'datetime'
  | 'scientific'
  | 'text'
  | 'custom';

export interface StoredNumberFormat {
  kind: StoredNumberFormatKind;
  decimals?: number;
  currency?: string;
  thousands?: boolean;
  dateStyle?: 'short' | 'medium' | 'long' | 'iso';
  pattern?: string;
}

export interface StoredBorderSide {
  style: 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted';
  color?: string;
}

export interface StoredBorders {
  top?: StoredBorderSide;
  right?: StoredBorderSide;
  bottom?: StoredBorderSide;
  left?: StoredBorderSide;
}

/** Mirrors `CellFormat` in `@pagespace/lib/sheets/types`. */
export interface CellFormat {
  number?: StoredNumberFormat;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  wrap?: boolean;
  color?: string;
  background?: string;
  borders?: StoredBorders;
  fontSize?: number;
  fontFamily?: 'sans' | 'mono';
}

export type StoredCellValue = number | string | boolean | '';

export interface StoredCellError {
  type: string;
  message?: string;
  details?: string[];
}

/**
 * One cell as persisted in `sheet_rows.cells`.
 *
 * Both halves are stored deliberately: `raw` is what the user authored (a
 * literal, or a formula beginning `=`), and `value` is the materialised result
 * of evaluating it. Keeping the computed value on the row is what lets a read —
 * a viewport fetch, a `query-rows` filter, an export — return without running
 * the evaluator at all. For a non-formula cell the two agree, and `value` is
 * still populated so readers need no special case.
 */
export interface StoredCell {
  raw: string;
  value?: StoredCellValue;
  type?: 'empty' | 'number' | 'string' | 'boolean';
  format?: CellFormat;
  error?: StoredCellError;
  notes?: string[];
}
