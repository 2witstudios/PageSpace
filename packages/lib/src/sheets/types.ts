/**
 * @module @pagespace/lib/sheets/types
 * @description Type definitions for sheet system
 */

export type SheetCellAddress = string;

/** How a cell's computed value is rendered. */
export type NumberFormatKind =
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

export interface NumberFormat {
  kind: NumberFormatKind;
  /** 0–10; ignored by kinds that have no fractional part. */
  decimals?: number;
  /** ISO 4217, for `kind: 'currency'`. */
  currency?: string;
  thousands?: boolean;
  dateStyle?: 'short' | 'medium' | 'long' | 'iso';
  /**
   * Only for `kind: 'custom'` — an imported pattern this engine cannot render.
   * Preserved through the round trip and displayed as `auto`, so an unsupported
   * format is never silently discarded.
   */
  pattern?: string;
}

export type CellHorizontalAlign = 'left' | 'center' | 'right';
export type CellVerticalAlign = 'top' | 'middle' | 'bottom';
export type CellFontFamily = 'sans' | 'mono';
export type CellBorderStyle = 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted';

export interface CellBorderSide {
  style: CellBorderStyle;
  /** `#rrggbb`; omitted means the theme's default border color. */
  color?: string;
}

export interface CellBorders {
  top?: CellBorderSide;
  right?: CellBorderSide;
  bottom?: CellBorderSide;
  left?: CellBorderSide;
}

/**
 * Presentation for a single cell. Deliberately separate from the cell's value:
 * `SheetData.cells` stays a plain string map, so clearing a cell's contents
 * leaves its formatting intact (as in Excel and Google Sheets) and every
 * existing consumer of `cells` is unaffected.
 */
export interface CellFormat {
  number?: NumberFormat;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  align?: CellHorizontalAlign;
  valign?: CellVerticalAlign;
  wrap?: boolean;
  /** `#rrggbb` text color. */
  color?: string;
  /** `#rrggbb` fill color. */
  background?: string;
  borders?: CellBorders;
  fontSize?: number;
  fontFamily?: CellFontFamily;
}

export interface SheetData {
  version: number;
  rowCount: number;
  columnCount: number;
  cells: Record<SheetCellAddress, string>;
  /** Per-cell presentation, keyed by A1 address. */
  formats?: Record<SheetCellAddress, CellFormat>;
  /** Column defaults, keyed by column letters ("A", "AB"). */
  columnFormats?: Record<string, CellFormat>;
  /** Column widths in px, keyed by column letters. */
  columnWidths?: Record<string, number>;
  /** Row heights in px, keyed by 1-based row number as a string. */
  rowHeights?: Record<string, number>;
  frozenRows?: number;
  frozenColumns?: number;
  /** Name of the sheet this data came from. */
  sheetName?: string;
  /**
   * Named/defined ranges, carried verbatim. Nothing in the engine resolves
   * them yet, but dropping what we do not understand turns every save into
   * silent data loss for anything written by a newer build or by hand.
   */
  ranges?: Record<string, Record<string, unknown>>;
  /**
   * Conditional formatting rules, applied in order. Evaluated by
   * `sheets/conditional` and merged beneath each cell's explicit format.
   */
  conditionalFormats?: import('./conditional').ConditionalRule[];
  /**
   * Tabs after the first, carried verbatim so a multi-tab document survives a
   * load/save cycle. The editor renders only the first sheet today; without
   * this, saving would silently delete every other tab.
   */
  extraSheets?: SheetDocSheet[];
}

export type SheetPrimitive = number | string | boolean | '';

export interface SheetDocCellError {
  type: string;
  message?: string;
  details?: string[];
}

export interface SheetDocCell {
  formula?: string;
  value?: SheetPrimitive;
  type?: string;
  notes?: string[];
  error?: SheetDocCellError;
  format?: CellFormat;
}

export interface SheetDocDependencyRecord {
  dependsOn: SheetCellAddress[];
  dependents: SheetCellAddress[];
}

export interface SheetDocSheet {
  name: string;
  order: number;
  meta: {
    rowCount: number;
    columnCount: number;
    frozenRows?: number;
    frozenColumns?: number;
    [key: string]: number | string | boolean | undefined;
  };
  columns: Record<string, Record<string, string | number | boolean>>;
  cells: Record<SheetCellAddress, SheetDocCell>;
  ranges: Record<string, Record<string, unknown>>;
  dependencies: Record<SheetCellAddress, SheetDocDependencyRecord>;
}

export interface SheetDoc {
  version: typeof import('./constants').SHEETDOC_VERSION;
  pageId?: string;
  sheets: SheetDocSheet[];
}

export interface SheetExternalReferenceToken {
  raw: string;
  label: string;
  normalizedLabel: string;
  identifier?: string;
  mentionType?: string;
}

export interface SheetExternalReferenceResolution {
  pageId: string;
  pageTitle: string;
  sheet?: SheetData;
  error?: string;
}

export interface SheetEvaluationOptions {
  pageId?: string;
  pageTitle?: string;
  resolveExternalReference?: (
    reference: SheetExternalReferenceToken
  ) => SheetExternalReferenceResolution | null | undefined;
}

export interface SheetEvaluationCell {
  address: SheetCellAddress;
  raw: string;
  value: SheetPrimitive;
  display: string;
  type: 'empty' | 'number' | 'string' | 'boolean';
  error?: string;
  dependsOn: SheetCellAddress[];
  dependents: SheetCellAddress[];
  /**
   * The format actually applied to `display`, with the column default already
   * resolved, so renderers do not each re-implement that precedence.
   */
  format?: CellFormat;
}

export interface SheetEvaluation {
  byAddress: Record<SheetCellAddress, SheetEvaluationCell>;
  display: string[][];
  errors: (string | null)[][];
  dependencies: Record<SheetCellAddress, SheetDocDependencyRecord>;
}

/**
 * An evaluation of only the cells that exist, with no materialized grids.
 *
 * A missing entry means an empty cell — the same thing the dense
 * `SheetEvaluation` stores an explicit empty record for. Consumers that already
 * guard the lookup (`byAddress[addr]?.display`) need no change to accept one.
 */
export interface SheetSparseEvaluation {
  byAddress: Record<SheetCellAddress, SheetEvaluationCell>;
  dependencies: Record<SheetCellAddress, SheetDocDependencyRecord>;
}

export interface SheetCellUpdate {
  address: string;
  value: string;
}

// Internal AST types (not exported publicly but used across modules)
export type TokenType =
  | 'number'
  | 'string'
  | 'boolean'
  | 'cell'
  | 'page'
  | 'identifier'
  | 'operator'
  | 'paren'
  | 'comma'
  | 'colon';

export type OperatorToken =
  | '+'
  | '-'
  | '*'
  | '/'
  | '^'
  | '&'
  | '='
  | '>'
  | '<'
  | '>='
  | '<='
  | '<>';

export interface Token {
  type: TokenType;
  value: string;
  meta?: Record<string, unknown>;
}

export interface NumberLiteralNode {
  type: 'NumberLiteral';
  value: number;
}

export interface StringLiteralNode {
  type: 'StringLiteral';
  value: string;
}

export interface BooleanLiteralNode {
  type: 'BooleanLiteral';
  value: boolean;
}

export interface CellReferenceNode {
  type: 'CellReference';
  reference: SheetCellAddress;
}

export interface RangeNode {
  type: 'Range';
  start: CellReferenceNode;
  end: CellReferenceNode;
}

export interface ExternalCellReferenceNode {
  type: 'ExternalCellReference';
  page: SheetExternalReferenceToken;
  reference: SheetCellAddress;
}

export interface ExternalRangeNode {
  type: 'ExternalRange';
  page: SheetExternalReferenceToken;
  start: CellReferenceNode;
  end: CellReferenceNode;
}

export interface UnaryExpressionNode {
  type: 'UnaryExpression';
  operator: '+' | '-';
  argument: ASTNode;
}

export interface BinaryExpressionNode {
  type: 'BinaryExpression';
  operator: OperatorToken;
  left: ASTNode;
  right: ASTNode;
}

export interface FunctionCallNode {
  type: 'FunctionCall';
  name: string;
  args: ASTNode[];
}

export type ASTNode =
  | NumberLiteralNode
  | StringLiteralNode
  | BooleanLiteralNode
  | CellReferenceNode
  | RangeNode
  | ExternalCellReferenceNode
  | ExternalRangeNode
  | UnaryExpressionNode
  | BinaryExpressionNode
  | FunctionCallNode;

export type EvalValue = SheetPrimitive | SheetPrimitive[];
export type AncestorSet = Set<string>;
