/**
 * @module @pagespace/lib/sheets/types
 * @description Type definitions for sheet system
 */

export type SheetCellAddress = string;

export interface SheetData {
  version: number;
  rowCount: number;
  columnCount: number;
  cells: Record<SheetCellAddress, string>;
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
}

export interface SheetEvaluation {
  byAddress: Record<SheetCellAddress, SheetEvaluationCell>;
  display: string[][];
  errors: (string | null)[][];
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
