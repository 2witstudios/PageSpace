import { PageType } from './enums';

export const SHEET_VERSION = 1;
export const SHEET_DEFAULT_ROWS = 20;
export const SHEET_DEFAULT_COLUMNS = 10;

export type SheetCellAddress = string;

export interface SheetData {
  version: number;
  rowCount: number;
  columnCount: number;
  cells: Record<SheetCellAddress, string>;
}

export type SheetPrimitive = number | string | boolean | '';

export interface SheetEvaluationCell {
  address: SheetCellAddress;
  raw: string;
  value: SheetPrimitive;
  display: string;
  type: 'empty' | 'number' | 'string' | 'boolean';
  error?: string;
}

export interface SheetEvaluation {
  byAddress: Record<SheetCellAddress, SheetEvaluationCell>;
  display: string[][];
  errors: (string | null)[][];
}

type TokenType =
  | 'number'
  | 'string'
  | 'cell'
  | 'identifier'
  | 'operator'
  | 'paren'
  | 'comma'
  | 'colon';

type OperatorToken =
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

interface Token {
  type: TokenType;
  value: string;
}

interface NumberLiteralNode {
  type: 'NumberLiteral';
  value: number;
}

interface StringLiteralNode {
  type: 'StringLiteral';
  value: string;
}

interface CellReferenceNode {
  type: 'CellReference';
  reference: SheetCellAddress;
}

interface RangeNode {
  type: 'Range';
  start: CellReferenceNode;
  end: CellReferenceNode;
}

interface UnaryExpressionNode {
  type: 'UnaryExpression';
  operator: '+' | '-';
  argument: ASTNode;
}

interface BinaryExpressionNode {
  type: 'BinaryExpression';
  operator: OperatorToken;
  left: ASTNode;
  right: ASTNode;
}

interface FunctionCallNode {
  type: 'FunctionCall';
  name: string;
  args: ASTNode[];
}

type ASTNode =
  | NumberLiteralNode
  | StringLiteralNode
  | CellReferenceNode
  | RangeNode
  | UnaryExpressionNode
  | BinaryExpressionNode
  | FunctionCallNode;

type EvalValue = SheetPrimitive | SheetPrimitive[];

type AncestorSet = Set<SheetCellAddress>;

const numberRegex = /^-?(?:\d+\.?\d*|\.\d+)$/;
const cellRegex = /^[A-Z]+\d+$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function cloneCells(cells: Record<string, string>): Record<string, string> {
  return { ...cells };
}

export function createEmptySheet(
  rows: number = SHEET_DEFAULT_ROWS,
  columns: number = SHEET_DEFAULT_COLUMNS
): SheetData {
  return {
    version: SHEET_VERSION,
    rowCount: Math.max(1, Math.floor(rows)),
    columnCount: Math.max(1, Math.floor(columns)),
    cells: {},
  };
}

export function parseSheetContent(content: unknown): SheetData {
  if (!content) {
    return createEmptySheet();
  }

  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed) {
      return createEmptySheet();
    }

    try {
      const parsed = JSON.parse(trimmed);
      return parseSheetContent(parsed);
    } catch {
      return createEmptySheet();
    }
  }

  if (!isObject(content)) {
    return createEmptySheet();
  }

  const version = typeof content.version === 'number' ? content.version : SHEET_VERSION;
  const rowCount =
    typeof content.rowCount === 'number' && Number.isFinite(content.rowCount)
      ? Math.max(1, Math.floor(content.rowCount))
      : SHEET_DEFAULT_ROWS;
  const columnCount =
    typeof content.columnCount === 'number' && Number.isFinite(content.columnCount)
      ? Math.max(1, Math.floor(content.columnCount))
      : SHEET_DEFAULT_COLUMNS;
  const cells: Record<string, string> = {};

  if (isObject(content.cells)) {
    for (const [key, value] of Object.entries(content.cells)) {
      if (typeof value === 'string') {
        cells[key.toUpperCase()] = value;
      } else if (value !== null && value !== undefined) {
        cells[key.toUpperCase()] = String(value);
      }
    }
  }

  return {
    version,
    rowCount,
    columnCount,
    cells,
  };
}

export function serializeSheetContent(sheet: SheetData): string {
  return JSON.stringify(sheet);
}

export function encodeCellAddress(rowIndex: number, columnIndex: number): SheetCellAddress {
  if (rowIndex < 0 || columnIndex < 0) {
    throw new Error('Row and column indices must be non-negative');
  }

  let column = '';
  let index = columnIndex;

  while (index >= 0) {
    column = String.fromCharCode((index % 26) + 65) + column;
    index = Math.floor(index / 26) - 1;
  }

  return `${column}${rowIndex + 1}`;
}

export function decodeCellAddress(address: SheetCellAddress): { row: number; column: number } {
  const match = address.toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!match) {
    throw new Error(`Invalid cell reference: ${address}`);
  }

  const [, columnLetters, rowPart] = match;
  let column = 0;

  for (let i = 0; i < columnLetters.length; i++) {
    column *= 26;
    column += columnLetters.charCodeAt(i) - 64;
  }

  return {
    row: parseInt(rowPart, 10) - 1,
    column: column - 1,
  };
}

function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < formula.length) {
    const char = formula[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '"') {
      let end = index + 1;
      let value = '';
      while (end < formula.length && formula[end] !== '"') {
        value += formula[end];
        end += 1;
      }
      if (end >= formula.length) {
        throw new Error('Unterminated string literal');
      }
      tokens.push({ type: 'string', value });
      index = end + 1;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      let end = index + 1;
      while (end < formula.length && /[0-9.]/.test(formula[end])) {
        end += 1;
      }
      const value = formula.slice(index, end);
      if (!numberRegex.test(value)) {
        throw new Error(`Invalid number literal: ${value}`);
      }
      tokens.push({ type: 'number', value });
      index = end;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < formula.length && /[A-Za-z0-9_]/.test(formula[end])) {
        end += 1;
      }
      const raw = formula.slice(index, end);
      const upper = raw.toUpperCase();
      if (cellRegex.test(upper)) {
        tokens.push({ type: 'cell', value: upper });
      } else {
        tokens.push({ type: 'identifier', value: upper });
      }
      index = end;
      continue;
    }

    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char });
      index += 1;
      continue;
    }

    if (char === ',') {
      tokens.push({ type: 'comma', value: char });
      index += 1;
      continue;
    }

    if (char === ':') {
      tokens.push({ type: 'colon', value: char });
      index += 1;
      continue;
    }

    if (char === '<' || char === '>' || char === '=') {
      const next = formula[index + 1];
      if (char === '<' && next === '=') {
        tokens.push({ type: 'operator', value: '<=' });
        index += 2;
        continue;
      }
      if (char === '>' && next === '=') {
        tokens.push({ type: 'operator', value: '>=' });
        index += 2;
        continue;
      }
      if (char === '<' && next === '>') {
        tokens.push({ type: 'operator', value: '<>' });
        index += 2;
        continue;
      }
      tokens.push({ type: 'operator', value: char });
      index += 1;
      continue;
    }

    if (char === '+' || char === '-' || char === '*' || char === '/' || char === '^' || char === '&') {
      tokens.push({ type: 'operator', value: char });
      index += 1;
      continue;
    }

    throw new Error(`Unexpected character '${char}' in formula`);
  }

  return tokens;
}

class FormulaParser {
  private tokens: Token[];
  private position = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ASTNode {
    const expression = this.parseComparison();
    if (!this.isAtEnd()) {
      throw new Error('Unexpected tokens after end of formula');
    }
    return expression;
  }

  private parseComparison(): ASTNode {
    let node = this.parseConcatenation();

    while (this.matchOperator('=', '>', '<', '>=', '<=', '<>')) {
      const operator = this.previous().value as OperatorToken;
      const right = this.parseConcatenation();
      node = {
        type: 'BinaryExpression',
        operator,
        left: node,
        right,
      };
    }

    return node;
  }

  private parseConcatenation(): ASTNode {
    let node = this.parseAddition();

    while (this.matchOperator('&')) {
      const operator = this.previous().value as OperatorToken;
      const right = this.parseAddition();
      node = {
        type: 'BinaryExpression',
        operator,
        left: node,
        right,
      };
    }

    return node;
  }

  private parseAddition(): ASTNode {
    let node = this.parseMultiplication();

    while (this.matchOperator('+', '-')) {
      const operator = this.previous().value as OperatorToken;
      const right = this.parseMultiplication();
      node = {
        type: 'BinaryExpression',
        operator,
        left: node,
        right,
      };
    }

    return node;
  }

  private parseMultiplication(): ASTNode {
    let node = this.parseExponent();

    while (this.matchOperator('*', '/')) {
      const operator = this.previous().value as OperatorToken;
      const right = this.parseExponent();
      node = {
        type: 'BinaryExpression',
        operator,
        left: node,
        right,
      };
    }

    return node;
  }

  private parseExponent(): ASTNode {
    let node = this.parseUnary();

    while (this.matchOperator('^')) {
      const operator = this.previous().value as OperatorToken;
      const right = this.parseUnary();
      node = {
        type: 'BinaryExpression',
        operator,
        left: node,
        right,
      };
    }

    return node;
  }

  private parseUnary(): ASTNode {
    if (this.matchOperator('+', '-')) {
      const operator = this.previous().value as '+' | '-';
      const argument = this.parseUnary();
      return {
        type: 'UnaryExpression',
        operator,
        argument,
      };
    }

    return this.parseRange();
  }

  private parseRange(): ASTNode {
    const left = this.parsePrimary();

    if (this.match('colon')) {
      const right = this.parsePrimary();
      if (left.type !== 'CellReference' || right.type !== 'CellReference') {
        throw new Error('Range references must use cell addresses');
      }
      return {
        type: 'Range',
        start: left,
        end: right,
      };
    }

    return left;
  }

  private parsePrimary(): ASTNode {
    if (this.match('number')) {
      return {
        type: 'NumberLiteral',
        value: Number(this.previous().value),
      };
    }

    if (this.match('string')) {
      return {
        type: 'StringLiteral',
        value: this.previous().value,
      };
    }

    if (this.match('cell')) {
      return {
        type: 'CellReference',
        reference: this.previous().value,
      };
    }

    if (this.match('identifier')) {
      const name = this.previous().value;
      if (!this.matchSpecific('paren', '(')) {
        throw new Error(`Unexpected identifier '${name}'`);
      }
      const args: ASTNode[] = [];
      if (!this.check('paren', ')')) {
        do {
          args.push(this.parseComparison());
        } while (this.match('comma'));
      }
      this.consume('paren', ')', `Expected closing parenthesis for ${name}()`);
      return {
        type: 'FunctionCall',
        name,
        args,
      };
    }

    if (this.matchSpecific('paren', '(')) {
      const expr = this.parseComparison();
      this.consume('paren', ')', 'Expected closing parenthesis');
      return expr;
    }

    throw new Error('Unexpected end of formula');
  }

  private match(...types: TokenType[]): boolean {
    for (const type of types) {
      if (this.check(type)) {
        this.advance();
        return true;
      }
    }
    return false;
  }

  private matchSpecific(type: TokenType, value: string): boolean {
    if (this.check(type, value)) {
      this.advance();
      return true;
    }
    return false;
  }

  private matchOperator(...operators: OperatorToken[]): boolean {
    if (!this.check('operator')) {
      return false;
    }
    const token = this.peek();
    if (operators.includes(token.value as OperatorToken)) {
      this.advance();
      return true;
    }
    return false;
  }

  private consume(type: TokenType, value: string, message: string): Token {
    if (this.check(type, value)) {
      return this.advance();
    }
    throw new Error(message);
  }

  private check(type: TokenType, value?: string): boolean {
    if (this.isAtEnd()) {
      return false;
    }
    const token = this.peek();
    if (token.type !== type) {
      return false;
    }
    if (value !== undefined) {
      return token.value === value;
    }
    return true;
  }

  private advance(): Token {
    if (!this.isAtEnd()) {
      this.position += 1;
    }
    return this.previous();
  }

  private isAtEnd(): boolean {
    return this.position >= this.tokens.length;
  }

  private peek(): Token {
    return this.tokens[this.position];
  }

  private previous(): Token {
    return this.tokens[this.position - 1];
  }
}

function formatDisplayValue(value: SheetPrimitive): string {
  if (value === '') {
    return '';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return '#ERROR';
    }
    const stringValue = value.toString();
    return stringValue.length > 12 ? value.toPrecision(12).replace(/0+$/g, '').replace(/\.$/, '') : stringValue;
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  return value;
}

function expandRange(start: string, end: string): SheetCellAddress[] {
  const { row: startRow, column: startColumn } = decodeCellAddress(start);
  const { row: endRow, column: endColumn } = decodeCellAddress(end);

  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const minCol = Math.min(startColumn, endColumn);
  const maxCol = Math.max(startColumn, endColumn);

  const addresses: SheetCellAddress[] = [];

  for (let row = minRow; row <= maxRow; row++) {
    for (let column = minCol; column <= maxCol; column++) {
      addresses.push(encodeCellAddress(row, column));
    }
  }

  return addresses;
}

function coerceNumber(value: SheetPrimitive): number {
  if (value === '') {
    return 0;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }
  const parsed = Number(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error('Expected a numeric value');
  }
  return parsed;
}

function toBoolean(value: SheetPrimitive): boolean {
  if (value === '') {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toUpperCase();
  if (normalized === 'TRUE') {
    return true;
  }
  if (normalized === 'FALSE') {
    return false;
  }
  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric)) {
    return numeric !== 0;
  }
  return true;
}

function flattenValue(value: EvalValue): SheetPrimitive[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenValue(item));
  }
  return [value];
}

function evaluateFunction(
  name: string,
  args: ASTNode[],
  evaluateNode: (node: ASTNode) => EvalValue
): SheetPrimitive {
  const upperName = name.toUpperCase();
  const values = args.flatMap((arg) => flattenValue(evaluateNode(arg)));

  switch (upperName) {
    case 'SUM': {
      return values.reduce<number>((total, value) => total + coerceNumber(value), 0);
    }
    case 'AVERAGE':
    case 'AVG': {
      const numericValues = values.filter((value) => {
        try {
          coerceNumber(value);
          return true;
        } catch {
          return false;
        }
      });
      if (numericValues.length === 0) {
        return 0;
      }
      const sum = numericValues.reduce<number>((total, value) => total + coerceNumber(value), 0);
      return sum / numericValues.length;
    }
    case 'MIN': {
      const numericValues = values.map((value) => coerceNumber(value));
      return numericValues.length ? Math.min(...numericValues) : 0;
    }
    case 'MAX': {
      const numericValues = values.map((value) => coerceNumber(value));
      return numericValues.length ? Math.max(...numericValues) : 0;
    }
    case 'COUNT': {
      return values.reduce<number>((count, value) => {
        if (value === '' || value === null || value === undefined) {
          return count;
        }
        if (typeof value === 'number') {
          return count + 1;
        }
        if (typeof value === 'boolean') {
          return count + 1;
        }
        const numeric = Number(value);
        return Number.isNaN(numeric) ? count : count + 1;
      }, 0);
    }
    case 'COUNTA': {
      return values.reduce<number>((count, value) => (value === '' ? count : count + 1), 0);
    }
    case 'ABS': {
      if (values.length !== 1) {
        throw new Error('ABS expects exactly one argument');
      }
      return Math.abs(coerceNumber(values[0]));
    }
    case 'ROUND': {
      if (values.length === 0) {
        throw new Error('ROUND expects at least one argument');
      }
      const value = coerceNumber(values[0]);
      const precision = values.length > 1 ? coerceNumber(values[1]) : 0;
      const factor = Math.pow(10, precision);
      return Math.round(value * factor) / factor;
    }
    case 'FLOOR': {
      if (values.length === 0) {
        throw new Error('FLOOR expects at least one argument');
      }
      const value = coerceNumber(values[0]);
      const significance = values.length > 1 ? Math.abs(coerceNumber(values[1])) : 1;
      if (significance === 0) {
        throw new Error('FLOOR significance cannot be zero');
      }
      return Math.floor(value / significance) * significance;
    }
    case 'CEILING': {
      if (values.length === 0) {
        throw new Error('CEILING expects at least one argument');
      }
      const value = coerceNumber(values[0]);
      const significance = values.length > 1 ? Math.abs(coerceNumber(values[1])) : 1;
      if (significance === 0) {
        throw new Error('CEILING significance cannot be zero');
      }
      return Math.ceil(value / significance) * significance;
    }
    case 'IF': {
      if (args.length < 2) {
        throw new Error('IF expects at least two arguments');
      }
      const conditionValue = flattenValue(evaluateNode(args[0]))[0];
      const condition = toBoolean(conditionValue);
      if (condition) {
        return flattenValue(evaluateNode(args[1]))[0];
      }
      if (args.length >= 3) {
        return flattenValue(evaluateNode(args[2]))[0];
      }
      return '';
    }
    default:
      throw new Error(`Unsupported function ${upperName}`);
  }
}

function evaluateNode(
  node: ASTNode,
  getCell: (reference: string, ancestors: AncestorSet) => SheetEvaluationCell,
  ancestors: AncestorSet
): EvalValue {
  switch (node.type) {
    case 'NumberLiteral':
      return node.value;
    case 'StringLiteral':
      return node.value;
    case 'CellReference': {
      const cell = getCell(node.reference, ancestors);
      if (cell.error) {
        throw new Error(cell.error);
      }
      return cell.value;
    }
    case 'Range': {
      const addresses = expandRange(node.start.reference, node.end.reference);
      return addresses.map((address) => {
        const cell = getCell(address, ancestors);
        if (cell.error) {
          throw new Error(cell.error);
        }
        return cell.value;
      });
    }
    case 'UnaryExpression': {
      const argument = evaluateNode(node.argument, getCell, ancestors);
      const value = flattenValue(argument)[0];
      const numeric = coerceNumber(value);
      return node.operator === '-' ? -numeric : numeric;
    }
    case 'BinaryExpression': {
      const leftValue = flattenValue(evaluateNode(node.left, getCell, ancestors))[0];
      const rightValue = flattenValue(evaluateNode(node.right, getCell, ancestors))[0];

      switch (node.operator) {
        case '+': {
          try {
            const numericLeft = coerceNumber(leftValue);
            const numericRight = coerceNumber(rightValue);
            return numericLeft + numericRight;
          } catch {
            return `${formatDisplayValue(leftValue)}${formatDisplayValue(rightValue)}`;
          }
        }
        case '-':
          return coerceNumber(leftValue) - coerceNumber(rightValue);
        case '*':
          return coerceNumber(leftValue) * coerceNumber(rightValue);
        case '/': {
          const denominator = coerceNumber(rightValue);
          if (denominator === 0) {
            throw new Error('Division by zero');
          }
          return coerceNumber(leftValue) / denominator;
        }
        case '^':
          return Math.pow(coerceNumber(leftValue), coerceNumber(rightValue));
        case '&':
          return `${formatDisplayValue(leftValue)}${formatDisplayValue(rightValue)}`;
        case '=': {
          try {
            return coerceNumber(leftValue) === coerceNumber(rightValue);
          } catch {
            return formatDisplayValue(leftValue) === formatDisplayValue(rightValue);
          }
        }
        case '>':
          return coerceNumber(leftValue) > coerceNumber(rightValue);
        case '<':
          return coerceNumber(leftValue) < coerceNumber(rightValue);
        case '>=':
          return coerceNumber(leftValue) >= coerceNumber(rightValue);
        case '<=':
          return coerceNumber(leftValue) <= coerceNumber(rightValue);
        case '<>': {
          try {
            return coerceNumber(leftValue) !== coerceNumber(rightValue);
          } catch {
            return formatDisplayValue(leftValue) !== formatDisplayValue(rightValue);
          }
        }
        default:
          throw new Error('Unsupported operator');
      }
    }
    case 'FunctionCall': {
      return evaluateFunction(node.name, node.args, (child) => evaluateNode(child, getCell, ancestors));
    }
    default:
      throw new Error('Unsupported expression');
  }
}

function evaluateCellInternal(
  address: SheetCellAddress,
  sheet: SheetData,
  cache: Map<SheetCellAddress, SheetEvaluationCell>,
  ancestors: AncestorSet
): SheetEvaluationCell {
  const normalized = address.toUpperCase();

  if (cache.has(normalized)) {
    return cache.get(normalized)!;
  }

  if (ancestors.has(normalized)) {
    const circular: SheetEvaluationCell = {
      address: normalized,
      raw: sheet.cells[normalized] ?? '',
      value: '',
      display: '#CYCLE',
      type: 'empty',
      error: 'Circular reference detected',
    };
    cache.set(normalized, circular);
    return circular;
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(normalized);

  const rawInput = sheet.cells[normalized] ?? '';
  const trimmed = rawInput.trim();

  let result: SheetEvaluationCell;

  if (!trimmed) {
    result = {
      address: normalized,
      raw: rawInput,
      value: '',
      display: '',
      type: 'empty',
    };
  } else if (trimmed.startsWith('=')) {
    const formula = trimmed.slice(1);
    try {
      const tokens = tokenize(formula);
      if (tokens.length === 0) {
        throw new Error('Empty formula');
      }
      const parser = new FormulaParser(tokens);
      const ast = parser.parse();
      const evaluated = evaluateNode(
        ast,
        (reference, ancestorsSet) => evaluateCellInternal(reference, sheet, cache, ancestorsSet),
        nextAncestors
      );
      const value = flattenValue(evaluated)[0];
      const type = value === '' ? 'empty' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
      result = {
        address: normalized,
        raw: rawInput,
        value,
        display: formatDisplayValue(value),
        type,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Formula error';
      result = {
        address: normalized,
        raw: rawInput,
        value: '',
        display: '#ERROR',
        type: 'empty',
        error: message,
      };
    }
  } else if (numberRegex.test(trimmed)) {
    const numericValue = Number(trimmed);
    result = {
      address: normalized,
      raw: rawInput,
      value: numericValue,
      display: formatDisplayValue(numericValue),
      type: 'number',
    };
  } else {
    result = {
      address: normalized,
      raw: rawInput,
      value: rawInput,
      display: rawInput,
      type: 'string',
    };
  }

  cache.set(normalized, result);
  return result;
}

export function evaluateSheet(sheet: SheetData): SheetEvaluation {
  const rowCount = Math.max(1, sheet.rowCount);
  const columnCount = Math.max(1, sheet.columnCount);
  const cache = new Map<SheetCellAddress, SheetEvaluationCell>();
  const byAddress: Record<string, SheetEvaluationCell> = {};
  const display: string[][] = Array.from({ length: rowCount }, () => Array(columnCount).fill(''));
  const errors: (string | null)[][] = Array.from({ length: rowCount }, () => Array(columnCount).fill(null));

  for (let row = 0; row < rowCount; row++) {
    for (let column = 0; column < columnCount; column++) {
      const address = encodeCellAddress(row, column);
      const cell = evaluateCellInternal(address, sheet, cache, new Set());
      byAddress[address] = cell;
      display[row][column] = cell.error ? '#ERROR' : cell.display;
      errors[row][column] = cell.error ?? null;
    }
  }

  return {
    byAddress,
    display,
    errors,
  };
}

export function sanitizeSheetData(sheet: SheetData): SheetData {
  const parsed = parseSheetContent(sheet);
  const sanitizedCells = cloneCells(parsed.cells);

  for (const key of Object.keys(sanitizedCells)) {
    const normalized = key.toUpperCase();
    if (!cellRegex.test(normalized)) {
      delete sanitizedCells[key];
      continue;
    }

    try {
      const { row, column } = decodeCellAddress(normalized);
      if (row < 0 || column < 0) {
        delete sanitizedCells[key];
      }
    } catch {
      delete sanitizedCells[key];
    }
  }

  return {
    ...parsed,
    cells: sanitizedCells,
  };
}

export function isSheetType(type: PageType): boolean {
  return type === PageType.SHEET;
}
