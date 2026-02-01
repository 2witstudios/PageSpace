import { parse as parseToml } from '@iarna/toml';

import { PageType } from '../utils/enums';

export const SHEET_VERSION = 1;
export const SHEET_DEFAULT_ROWS = 20;
export const SHEET_DEFAULT_COLUMNS = 10;

export const SHEETDOC_MAGIC = '#%PAGESPACE_SHEETDOC';
export const SHEETDOC_VERSION = 'v1';

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
  version: typeof SHEETDOC_VERSION;
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

type TokenType =
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
  meta?: Record<string, unknown>;
}

interface NumberLiteralNode {
  type: 'NumberLiteral';
  value: number;
}

interface StringLiteralNode {
  type: 'StringLiteral';
  value: string;
}

interface BooleanLiteralNode {
  type: 'BooleanLiteral';
  value: boolean;
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

interface ExternalCellReferenceNode {
  type: 'ExternalCellReference';
  page: SheetExternalReferenceToken;
  reference: SheetCellAddress;
}

interface ExternalRangeNode {
  type: 'ExternalRange';
  page: SheetExternalReferenceToken;
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
  | BooleanLiteralNode
  | CellReferenceNode
  | RangeNode
  | ExternalCellReferenceNode
  | ExternalRangeNode
  | UnaryExpressionNode
  | BinaryExpressionNode
  | FunctionCallNode;

type EvalValue = SheetPrimitive | SheetPrimitive[];

type AncestorSet = Set<string>;

const numberRegex = /^-?(?:\d+\.?\d*|\.\d+)$/;
const cellRegex = /^[A-Z]+\d+$/;
const externalReferenceRegex =
  /^@\[(?<label>[^\]]+)\](?:\((?<identifier>[^):]+)(?::(?<mentionType>[^)]+))?\))?:(?<address>[A-Z]+\d+)$/i;

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

    if (isSheetDocString(trimmed)) {
      try {
        const doc = parseSheetDocString(trimmed);
        return sheetDataFromSheetDoc(doc);
      } catch {
        return createEmptySheet();
      }
    }

    try {
      const parsed = JSON.parse(trimmed);
      return parseSheetContent(parsed);
    } catch {
      return createEmptySheet();
    }
  }

  if (isSheetDocObject(content)) {
    try {
      return sheetDataFromSheetDoc(normalizeSheetDocObject(content));
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

export function serializeSheetContent(
  sheet: SheetData,
  options: { pageId?: string; sheetName?: string } = {}
): string {
  const sanitized = sanitizeSheetData({ ...sheet });
  const evaluation = evaluateSheet(sanitized);
  const doc = sheetDataToSheetDoc(sanitized, evaluation, options);
  return stringifySheetDoc(doc);
}

function isSheetDocString(value: string): boolean {
  return value.trimStart().startsWith(SHEETDOC_MAGIC);
}

export function parseSheetDocString(value: string): SheetDoc {
  const lines = value.split(/\r?\n/);
  let headerIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim()) {
      headerIndex = index;
      break;
    }
  }

  if (headerIndex === -1) {
    throw new Error('Missing SheetDoc header');
  }

  const headerLine = lines[headerIndex].trim();

  if (!headerLine.startsWith(SHEETDOC_MAGIC)) {
    throw new Error('Invalid SheetDoc header');
  }

  const versionPart = headerLine.slice(SHEETDOC_MAGIC.length).trim();
  if (versionPart && versionPart !== SHEETDOC_VERSION) {
    throw new Error(`Unsupported SheetDoc version: ${versionPart}`);
  }

  const tomlSource = lines.slice(headerIndex + 1).join('\n');
  const parsed = tomlSource.trim() ? (parseToml(tomlSource) as Record<string, unknown>) : {};
  return normalizeSheetDocObject(parsed);
}

function isSheetDocObject(value: unknown): value is Record<string, unknown> {
  return isObject(value) && Array.isArray((value as { sheets?: unknown }).sheets);
}

function normalizeSheetDocObject(value: Record<string, unknown>): SheetDoc {
  const pageId = typeof value.page_id === 'string' ? value.page_id : undefined;
  const sheetsInput = Array.isArray(value.sheets) ? value.sheets : [];
  const sheets: SheetDocSheet[] = [];

  sheetsInput.forEach((sheetValue, index) => {
    if (!isObject(sheetValue)) {
      return;
    }

    const name = typeof sheetValue.name === 'string' ? sheetValue.name : `Sheet ${index + 1}`;
    const order =
      typeof sheetValue.order === 'number' && Number.isFinite(sheetValue.order)
        ? sheetValue.order
        : index;

    const metaSource = isObject(sheetValue.meta) ? sheetValue.meta : {};
    const rowCount =
      typeof metaSource.row_count === 'number' && Number.isFinite(metaSource.row_count)
        ? Math.max(1, Math.floor(metaSource.row_count))
        : SHEET_DEFAULT_ROWS;
    const columnCount =
      typeof metaSource.column_count === 'number' && Number.isFinite(metaSource.column_count)
        ? Math.max(1, Math.floor(metaSource.column_count))
        : SHEET_DEFAULT_COLUMNS;
    const meta: SheetDocSheet['meta'] = {
      rowCount,
      columnCount,
    };

    if (typeof metaSource.frozen_rows === 'number' && Number.isFinite(metaSource.frozen_rows)) {
      meta.frozenRows = Math.max(0, Math.floor(metaSource.frozen_rows));
    }

    if (typeof metaSource.frozen_columns === 'number' && Number.isFinite(metaSource.frozen_columns)) {
      meta.frozenColumns = Math.max(0, Math.floor(metaSource.frozen_columns));
    }

    for (const [metaKey, metaValue] of Object.entries(metaSource)) {
      if (['row_count', 'column_count', 'frozen_rows', 'frozen_columns'].includes(metaKey)) {
        continue;
      }
      if (
        typeof metaValue === 'number' ||
        typeof metaValue === 'string' ||
        typeof metaValue === 'boolean'
      ) {
        meta[toCamelCase(metaKey)] = metaValue;
      }
    }

    const columns: Record<string, Record<string, string | number | boolean>> = {};
    if (isObject(sheetValue.columns)) {
      for (const [columnKey, columnValue] of Object.entries(sheetValue.columns)) {
        if (!isObject(columnValue)) {
          continue;
        }

        const normalized: Record<string, string | number | boolean> = {};
        for (const [propKey, propValue] of Object.entries(columnValue)) {
          if (
            typeof propValue === 'string' ||
            typeof propValue === 'number' ||
            typeof propValue === 'boolean'
          ) {
            normalized[propKey] = propValue;
          }
        }

        if (Object.keys(normalized).length > 0) {
          columns[columnKey.toUpperCase()] = normalized;
        }
      }
    }

    const cells: Record<SheetCellAddress, SheetDocCell> = {};
    if (isObject(sheetValue.cells)) {
      for (const [addressKey, cellValue] of Object.entries(sheetValue.cells)) {
        const normalizedAddress = normalizeCellAddress(addressKey);
        if (!normalizedAddress || !isObject(cellValue)) {
          continue;
        }

        const formula = typeof cellValue.formula === 'string' ? cellValue.formula.trim() : undefined;
        const valuePrimitive =
          'value' in cellValue ? coerceSheetPrimitive((cellValue as Record<string, unknown>).value) : undefined;
        const typeValue = typeof cellValue.type === 'string' ? cellValue.type : undefined;
        const notesValue = Array.isArray(cellValue.notes)
          ? cellValue.notes.filter((note): note is string => typeof note === 'string')
          : undefined;
        const errorValue = isObject(cellValue.error)
          ? normalizeCellError(cellValue.error as Record<string, unknown>)
          : undefined;

        const cell: SheetDocCell = {};
        if (formula) {
          cell.formula = formula;
        }
        if (valuePrimitive !== undefined) {
          cell.value = valuePrimitive;
        }
        if (typeValue) {
          cell.type = typeValue;
        }
        if (notesValue && notesValue.length > 0) {
          cell.notes = notesValue;
        }
        if (errorValue) {
          cell.error = errorValue;
        }

        if (Object.keys(cell).length > 0) {
          cells[normalizedAddress] = cell;
        }
      }
    }

    const ranges: Record<string, Record<string, unknown>> = {};
    if (isObject(sheetValue.ranges)) {
      for (const [rangeKey, rangeValue] of Object.entries(sheetValue.ranges)) {
        if (isObject(rangeValue)) {
          ranges[rangeKey] = clonePlainObject(rangeValue as Record<string, unknown>);
        }
      }
    }

    const dependencies: Record<SheetCellAddress, SheetDocDependencyRecord> = {};
    if (isObject(sheetValue.dependencies)) {
      for (const [addressKey, dependencyValue] of Object.entries(sheetValue.dependencies)) {
        const normalizedAddress = normalizeCellAddress(addressKey);
        if (!normalizedAddress || !isObject(dependencyValue)) {
          continue;
        }

        const dependsOn = Array.isArray(dependencyValue.depends_on)
          ? dependencyValue.depends_on
              .map((item) =>
                typeof item === 'string' ? normalizeDependencyReference(item) : null
              )
              .filter((ref): ref is string => Boolean(ref))
          : [];
        const dependents = Array.isArray(dependencyValue.dependents)
          ? dependencyValue.dependents
              .map((item) =>
                typeof item === 'string' ? normalizeDependencyReference(item) : null
              )
              .filter((ref): ref is string => Boolean(ref))
          : [];

        dependencies[normalizedAddress] = {
          dependsOn: uniqueSorted(dependsOn),
          dependents: uniqueSorted(dependents),
        };
      }
    }

    sheets.push({
      name,
      order,
      meta,
      columns,
      cells,
      ranges,
      dependencies,
    });
  });

  if (sheets.length === 0) {
    sheets.push({
      name: 'Sheet1',
      order: 0,
      meta: { rowCount: SHEET_DEFAULT_ROWS, columnCount: SHEET_DEFAULT_COLUMNS },
      columns: {},
      cells: {},
      ranges: {},
      dependencies: {},
    });
  }

  return sortSheetDoc({
    version: SHEETDOC_VERSION,
    pageId,
    sheets,
  });
}

function sortSheetDoc(doc: SheetDoc): SheetDoc {
  const sheets = [...doc.sheets]
    .map((sheet) => ({
      ...sheet,
      columns: sortRecord(sheet.columns, (value) => ({ ...value })),
      cells: sortRecord(sheet.cells, (cell) => normalizeCellForOutput(cell)),
      ranges: sortRecord(sheet.ranges, (range) => clonePlainObject(range)),
      dependencies: sortRecord(sheet.dependencies, (dependency) => ({
        dependsOn: uniqueSorted(dependency.dependsOn),
        dependents: uniqueSorted(dependency.dependents),
      })),
    }))
    .sort((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      return a.name.localeCompare(b.name);
    });

  return {
    ...doc,
    sheets,
  };
}

function sortRecord<T>(record: Record<string, T>, mapValue?: (value: T) => T): Record<string, T> {
  const entries = Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  const result: Record<string, T> = {};

  for (const [key, value] of entries) {
    result[key] = mapValue ? mapValue(value) : value;
  }

  return result;
}

function normalizeCellForOutput(cell: SheetDocCell): SheetDocCell {
  const normalized: SheetDocCell = {};

  if (cell.formula !== undefined) {
    normalized.formula = cell.formula;
  }
  if (cell.value !== undefined) {
    normalized.value = cell.value;
  }
  if (cell.type !== undefined) {
    normalized.type = cell.type;
  }
  if (cell.notes && cell.notes.length > 0) {
    normalized.notes = [...cell.notes];
  }
  if (cell.error) {
    normalized.error = {
      type: cell.error.type,
      ...(cell.error.message ? { message: cell.error.message } : {}),
      ...(cell.error.details && cell.error.details.length > 0
        ? { details: [...cell.error.details] }
        : {}),
    };
  }

  return normalized;
}

function sheetDataFromSheetDoc(doc: SheetDoc): SheetData {
  const normalized = sortSheetDoc(doc);
  const target = normalized.sheets[0];

  if (!target) {
    return createEmptySheet();
  }

  const cells: Record<string, string> = {};

  for (const [address, cell] of Object.entries(target.cells)) {
    const normalizedAddress = normalizeCellAddress(address);
    if (!normalizedAddress) {
      continue;
    }

    if (cell.formula) {
      const trimmed = cell.formula.trim();
      cells[normalizedAddress] = trimmed.startsWith('=') ? trimmed : `=${trimmed}`;
      continue;
    }

    if (cell.value !== undefined) {
      cells[normalizedAddress] = formatPrimitiveForCell(cell.value);
      continue;
    }
  }

  return {
    version: SHEET_VERSION,
    rowCount: Math.max(1, Math.floor(target.meta.rowCount)),
    columnCount: Math.max(1, Math.floor(target.meta.columnCount)),
    cells,
  };
}

function sheetDataToSheetDoc(
  sheet: SheetData,
  evaluation: SheetEvaluation,
  options: { pageId?: string; sheetName?: string }
): SheetDoc {
  const sheetName = options.sheetName ?? 'Sheet1';
  const cells: Record<SheetCellAddress, SheetDocCell> = {};
  const dependencies: Record<SheetCellAddress, SheetDocDependencyRecord> = {};
  const addresses = Object.keys(evaluation.byAddress).sort((a, b) => a.localeCompare(b));

  for (const address of addresses) {
    const evalCell = evaluation.byAddress[address];
    const raw = sheet.cells[address] ?? '';
    const trimmed = raw.trim();
    const docCell: SheetDocCell = {};

    if (trimmed.startsWith('=')) {
      docCell.formula = trimmed;
      docCell.value = evalCell.error ? '' : evalCell.value;
    } else if (trimmed !== '') {
      docCell.value = evalCell.value;
    }

    if (evalCell.type !== 'empty') {
      docCell.type = evalCell.type;
    }

    if (evalCell.error) {
      const errorType = evalCell.error.includes('Circular') ? 'CIRCULAR_REF' : 'EVAL_ERROR';
      const error: SheetDocCellError = {
        type: errorType,
        message: evalCell.error,
      };
      if (errorType === 'CIRCULAR_REF') {
        error.details = uniqueSorted([address, ...evalCell.dependsOn]);
      }
      docCell.error = error;
    }

    if (docCell.formula !== undefined || docCell.value !== undefined || docCell.type || docCell.error) {
      cells[address] = docCell;
    }

    if (evalCell.dependsOn.length > 0 || evalCell.dependents.length > 0) {
      dependencies[address] = {
        dependsOn: uniqueSorted(evalCell.dependsOn),
        dependents: uniqueSorted(evalCell.dependents),
      };
    }
  }

  return sortSheetDoc({
    version: SHEETDOC_VERSION,
    pageId: options.pageId,
    sheets: [
      {
        name: sheetName,
        order: 0,
        meta: {
          rowCount: Math.max(1, Math.floor(sheet.rowCount)),
          columnCount: Math.max(1, Math.floor(sheet.columnCount)),
        },
        columns: {},
        cells,
        ranges: {},
        dependencies,
      },
    ],
  });
}

export function stringifySheetDoc(doc: SheetDoc): string {
  const normalized = sortSheetDoc(doc);
  const lines: string[] = [`${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}`];

  if (normalized.pageId) {
    lines.push(`page_id = ${formatTomlString(normalized.pageId)}`);
  }

  for (const sheet of normalized.sheets) {
    lines.push('');
    lines.push('[[sheets]]');
    lines.push(`name = ${formatTomlString(sheet.name)}`);
    lines.push(`order = ${sheet.order}`);
    lines.push('');
    lines.push('[sheets.meta]');
    lines.push(`row_count = ${sheet.meta.rowCount}`);
    lines.push(`column_count = ${sheet.meta.columnCount}`);
    if (typeof sheet.meta.frozenRows === 'number') {
      lines.push(`frozen_rows = ${sheet.meta.frozenRows}`);
    }
    if (typeof sheet.meta.frozenColumns === 'number') {
      lines.push(`frozen_columns = ${sheet.meta.frozenColumns}`);
    }
    for (const [metaKey, metaValue] of Object.entries(sheet.meta)) {
      if (['rowCount', 'columnCount', 'frozenRows', 'frozenColumns'].includes(metaKey)) {
        continue;
      }
      if (metaValue === undefined) {
        continue;
      }
      lines.push(`${toSnakeCase(metaKey)} = ${formatTomlValue(metaValue)}`);
    }

    if (Object.keys(sheet.columns).length > 0) {
      lines.push('');
      lines.push('[sheets.columns]');
      for (const [columnKey, columnValue] of Object.entries(sheet.columns)) {
        lines.push(`${columnKey} = ${formatInlineTable(columnValue)}`);
      }
    }

    for (const [address, cell] of Object.entries(sheet.cells)) {
      lines.push('');
      lines.push(`[sheets.cells.${address}]`);
      if (cell.formula !== undefined) {
        lines.push(`formula = ${formatTomlString(cell.formula)}`);
      }
      if (cell.value !== undefined) {
        lines.push(`value = ${formatTomlValue(cell.value)}`);
      }
      if (cell.type !== undefined) {
        lines.push(`type = ${formatTomlString(cell.type)}`);
      }
      if (cell.notes && cell.notes.length > 0) {
        lines.push(`notes = ${formatTomlValue(cell.notes)}`);
      }
      if (cell.error) {
        const errorRecord: Record<string, unknown> = {
          type: cell.error.type,
          ...(cell.error.message ? { message: cell.error.message } : {}),
          ...(cell.error.details ? { details: cell.error.details } : {}),
        };
        lines.push(`error = ${formatInlineTable(errorRecord)}`);
      }
    }

    if (Object.keys(sheet.ranges).length > 0) {
      for (const [rangeKey, rangeValue] of Object.entries(sheet.ranges)) {
        lines.push('');
        lines.push(`[sheets.ranges.${rangeKey}]`);
        for (const [rangePropKey, rangePropValue] of Object.entries(rangeValue)) {
          lines.push(`${rangePropKey} = ${formatTomlValue(rangePropValue)}`);
        }
      }
    }

    if (Object.keys(sheet.dependencies).length > 0) {
      for (const [address, dependency] of Object.entries(sheet.dependencies)) {
        lines.push('');
        lines.push(`[sheets.dependencies.${address}]`);
        lines.push(`depends_on = ${formatTomlValue(dependency.dependsOn)}`);
        lines.push(`dependents = ${formatTomlValue(dependency.dependents)}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

function formatPrimitiveForCell(value: SheetPrimitive): string {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

function formatTomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/\"/g, '\\"')}"`;
}

function formatTomlValue(value: unknown): string {
  if (value === null || value === undefined) {
    return formatTomlString('');
  }
  if (typeof value === 'string') {
    return formatTomlString(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '0';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => formatTomlValue(item));
    return `[${parts.join(', ')}]`;
  }
  if (isObject(value)) {
    return formatInlineTable(value as Record<string, unknown>);
  }
  return formatTomlString(String(value));
}

function formatInlineTable(record: Record<string, unknown>): string {
  const entries = Object.entries(record).filter(([, entryValue]) => entryValue !== undefined);
  const parts = entries.map(([key, entryValue]) => `${key} = ${formatTomlValue(entryValue)}`);
  if (parts.length === 0) {
    return '{}';
  }
  return `{ ${parts.join(', ')} }`;
}

function clonePlainObject(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry)) {
      result[key] = entry.map((item) =>
        isObject(item) ? clonePlainObject(item as Record<string, unknown>) : item
      );
      continue;
    }

    if (isObject(entry)) {
      result[key] = clonePlainObject(entry as Record<string, unknown>);
      continue;
    }

    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      result[key] = entry;
    }
  }

  return result;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function normalizeCellAddress(address: string | undefined): SheetCellAddress | null {
  if (!address) {
    return null;
  }

  const upper = address.trim().toUpperCase();
  return cellRegex.test(upper) ? upper : null;
}

function normalizeDependencyReference(reference: string | undefined): string | null {
  if (!reference) {
    return null;
  }

  const trimmed = reference.trim();
  if (!trimmed) {
    return null;
  }

  const upper = trimmed.toUpperCase();
  if (cellRegex.test(upper)) {
    return upper;
  }

  const match = trimmed.match(externalReferenceRegex);
  if (!match || !match.groups) {
    return null;
  }

  const label = (match.groups.label ?? '').trim();
  if (!label) {
    return null;
  }

  const identifier = match.groups.identifier ? match.groups.identifier.trim() : undefined;
  const mentionType = match.groups.mentionType ? match.groups.mentionType.trim() : undefined;
  const address = match.groups.address ? match.groups.address.toUpperCase() : undefined;

  if (!address || !cellRegex.test(address)) {
    return null;
  }

  const idPart = identifier ? `(${identifier}${mentionType ? `:${mentionType}` : ''})` : '';
  return `@[${label}]${idPart}:${address}`;
}

function formatExternalReference(page: SheetExternalReferenceToken, address: SheetCellAddress): string {
  const normalizedAddress = address.toUpperCase();
  const label = page.label.trim();
  const identifier = page.identifier?.trim();
  const mentionType = page.mentionType?.trim();
  const idPart = identifier ? `(${identifier}${mentionType ? `:${mentionType}` : ''})` : '';
  return `@[${label}]${idPart}:${normalizedAddress}`;
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

function toSnakeCase(value: string): string {
  return value.replace(/([A-Z])/g, '_$1').toLowerCase();
}

function coerceSheetPrimitive(value: unknown): SheetPrimitive | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return '';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value;
  }
  return undefined;
}

function normalizeCellError(value: Record<string, unknown>): SheetDocCellError | undefined {
  const type = typeof value.type === 'string' ? value.type : undefined;
  const message = typeof value.message === 'string' ? value.message : undefined;
  const details = Array.isArray(value.details)
    ? value.details.filter((entry): entry is string => typeof entry === 'string')
    : undefined;

  if (!type && !message && (!details || details.length === 0)) {
    return undefined;
  }

  const error: SheetDocCellError = {
    type: type ?? 'EVAL_ERROR',
  };

  if (message) {
    error.message = message;
  }

  if (details && details.length > 0) {
    error.details = uniqueSorted(details);
  }

  return error;
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

    if (char === '@' && formula[index + 1] === '[') {
      let end = index + 2;
      let label = '';
      while (end < formula.length && formula[end] !== ']') {
        label += formula[end];
        end += 1;
      }
      if (end >= formula.length) {
        throw new Error('Unterminated page reference');
      }

      const trimmedLabel = label.trim();
      if (!trimmedLabel) {
        throw new Error('Page reference label cannot be empty');
      }

      let cursor = end + 1;
      let identifier: string | undefined;
      let mentionType: string | undefined;
      let rawSuffix = '';

      if (formula[cursor] === '(') {
        cursor += 1;
        let metaEnd = cursor;
        while (metaEnd < formula.length && formula[metaEnd] !== ')') {
          metaEnd += 1;
        }
        if (metaEnd >= formula.length) {
          throw new Error('Unterminated page reference identifier');
        }
        const metaContent = formula.slice(cursor, metaEnd).trim();
        rawSuffix = metaContent ? `(${metaContent})` : '';
        if (metaContent) {
          const colonIndex = metaContent.indexOf(':');
          if (colonIndex === -1) {
            identifier = metaContent.trim();
          } else {
            identifier = metaContent.slice(0, colonIndex).trim();
            const typePart = metaContent.slice(colonIndex + 1).trim();
            if (typePart) {
              mentionType = typePart;
            }
          }
        }
        cursor = metaEnd + 1;
      }

      const rawMention = `@[${trimmedLabel}]${rawSuffix}`;
      const pageMeta: SheetExternalReferenceToken = {
        raw: rawMention,
        label: trimmedLabel,
        normalizedLabel: trimmedLabel.toLowerCase(),
        identifier: identifier && identifier.length > 0 ? identifier : undefined,
        mentionType: mentionType,
      };
      tokens.push({ type: 'page', value: rawMention, meta: { page: pageMeta } });
      index = cursor;
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
      } else if (upper === 'TRUE' || upper === 'FALSE') {
        tokens.push({ type: 'boolean', value: upper });
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

    if (this.match('boolean')) {
      return {
        type: 'BooleanLiteral',
        value: this.previous().value === 'TRUE',
      };
    }

    if (this.match('page')) {
      const token = this.previous();
      const meta = token.meta?.page as SheetExternalReferenceToken | undefined;
      if (!meta) {
        throw new Error('Invalid page reference');
      }
      this.consume('colon', ':', 'Expected ":" after page reference');
      const start = this.parseCellReference();
      if (this.match('colon')) {
        const end = this.parseCellReference();
        return {
          type: 'ExternalRange',
          page: meta,
          start,
          end,
        };
      }
      return {
        type: 'ExternalCellReference',
        page: meta,
        reference: start.reference,
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

  private parseCellReference(): CellReferenceNode {
    if (this.match('cell')) {
      return {
        type: 'CellReference',
        reference: this.previous().value,
      };
    }
    throw new Error('Expected cell reference after page reference');
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
    return value ? 'true' : 'false';
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

  // Handle functions that need lazy evaluation first (before evaluating all args)
  switch (upperName) {
    case 'IFERROR': {
      if (args.length < 2) {
        throw new Error('IFERROR expects at least two arguments');
      }
      try {
        return flattenValue(evaluateNode(args[0]))[0];
      } catch {
        return flattenValue(evaluateNode(args[1]))[0];
      }
    }
  }

  // For all other functions, evaluate args upfront
  const values = args.flatMap((arg) => flattenValue(evaluateNode(arg)));

  switch (upperName) {
    case 'SUM': {
      return values.reduce<number>((total, value) => total + coerceNumber(value), 0);
    }
    case 'AVERAGE':
    case 'AVG': {
      const numericValues = values.filter((value) => {
        // Exclude empty strings - they should not be counted in average
        if (value === '' || (typeof value === 'string' && value.trim() === '')) {
          return false;
        }
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
    case 'CONCAT':
    case 'CONCATENATE': {
      return values.map((value) => String(value)).join('');
    }
    // String functions
    case 'UPPER': {
      if (values.length !== 1) {
        throw new Error('UPPER expects exactly one argument');
      }
      return String(values[0]).toUpperCase();
    }
    case 'LOWER': {
      if (values.length !== 1) {
        throw new Error('LOWER expects exactly one argument');
      }
      return String(values[0]).toLowerCase();
    }
    case 'TRIM': {
      if (values.length !== 1) {
        throw new Error('TRIM expects exactly one argument');
      }
      return String(values[0]).trim();
    }
    case 'LEN': {
      if (values.length !== 1) {
        throw new Error('LEN expects exactly one argument');
      }
      return String(values[0]).length;
    }
    case 'LEFT': {
      if (values.length < 1 || values.length > 2) {
        throw new Error('LEFT expects one or two arguments');
      }
      const text = String(values[0]);
      const numChars = values.length > 1 ? coerceNumber(values[1]) : 1;
      return text.substring(0, Math.max(0, Math.floor(numChars)));
    }
    case 'RIGHT': {
      if (values.length < 1 || values.length > 2) {
        throw new Error('RIGHT expects one or two arguments');
      }
      const text = String(values[0]);
      const numChars = values.length > 1 ? coerceNumber(values[1]) : 1;
      const chars = Math.max(0, Math.floor(numChars));
      return chars > 0 ? text.slice(-chars) : '';
    }
    case 'MID': {
      if (values.length !== 3) {
        throw new Error('MID expects exactly three arguments');
      }
      const text = String(values[0]);
      const startNum = Math.max(1, Math.floor(coerceNumber(values[1])));
      const numChars = Math.max(0, Math.floor(coerceNumber(values[2])));
      return text.substring(startNum - 1, startNum - 1 + numChars);
    }
    case 'SUBSTITUTE': {
      if (values.length < 3 || values.length > 4) {
        throw new Error('SUBSTITUTE expects three or four arguments');
      }
      const text = String(values[0]);
      const oldText = String(values[1]);
      const newText = String(values[2]);
      if (values.length === 4) {
        const instanceNum = Math.floor(coerceNumber(values[3]));
        if (instanceNum < 1) {
          throw new Error('SUBSTITUTE instance_num must be positive');
        }
        let count = 0;
        return text.replace(new RegExp(oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), (match) => {
          count++;
          return count === instanceNum ? newText : match;
        });
      }
      return text.split(oldText).join(newText);
    }
    case 'REPT': {
      if (values.length !== 2) {
        throw new Error('REPT expects exactly two arguments');
      }
      const text = String(values[0]);
      const times = Math.max(0, Math.floor(coerceNumber(values[1])));
      if (times > 10000) {
        throw new Error('REPT repeat count too large');
      }
      return text.repeat(times);
    }
    case 'FIND': {
      if (values.length < 2 || values.length > 3) {
        throw new Error('FIND expects two or three arguments');
      }
      const findText = String(values[0]);
      const withinText = String(values[1]);
      const startNum = values.length > 2 ? Math.max(1, Math.floor(coerceNumber(values[2]))) : 1;
      const index = withinText.indexOf(findText, startNum - 1);
      if (index === -1) {
        throw new Error('FIND: Text not found');
      }
      return index + 1;
    }
    case 'SEARCH': {
      if (values.length < 2 || values.length > 3) {
        throw new Error('SEARCH expects two or three arguments');
      }
      const findText = String(values[0]).toLowerCase();
      const withinText = String(values[1]).toLowerCase();
      const startNum = values.length > 2 ? Math.max(1, Math.floor(coerceNumber(values[2]))) : 1;
      const index = withinText.indexOf(findText, startNum - 1);
      if (index === -1) {
        throw new Error('SEARCH: Text not found');
      }
      return index + 1;
    }
    // Date functions
    case 'TODAY': {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }
    case 'NOW': {
      return new Date().toISOString();
    }
    case 'YEAR': {
      if (values.length !== 1) {
        throw new Error('YEAR expects exactly one argument');
      }
      const date = new Date(String(values[0]));
      if (isNaN(date.getTime())) {
        throw new Error('YEAR: Invalid date');
      }
      return date.getFullYear();
    }
    case 'MONTH': {
      if (values.length !== 1) {
        throw new Error('MONTH expects exactly one argument');
      }
      const date = new Date(String(values[0]));
      if (isNaN(date.getTime())) {
        throw new Error('MONTH: Invalid date');
      }
      return date.getMonth() + 1;
    }
    case 'DAY': {
      if (values.length !== 1) {
        throw new Error('DAY expects exactly one argument');
      }
      const date = new Date(String(values[0]));
      if (isNaN(date.getTime())) {
        throw new Error('DAY: Invalid date');
      }
      return date.getDate();
    }
    // Logical functions
    case 'AND': {
      if (values.length === 0) {
        throw new Error('AND expects at least one argument');
      }
      return values.every((v) => toBoolean(v));
    }
    case 'OR': {
      if (values.length === 0) {
        throw new Error('OR expects at least one argument');
      }
      return values.some((v) => toBoolean(v));
    }
    case 'NOT': {
      if (values.length !== 1) {
        throw new Error('NOT expects exactly one argument');
      }
      return !toBoolean(values[0]);
    }
    case 'ISBLANK': {
      if (values.length !== 1) {
        throw new Error('ISBLANK expects exactly one argument');
      }
      return values[0] === '' || values[0] === null || values[0] === undefined;
    }
    case 'ISNUMBER': {
      if (values.length !== 1) {
        throw new Error('ISNUMBER expects exactly one argument');
      }
      return typeof values[0] === 'number' && Number.isFinite(values[0]);
    }
    case 'ISTEXT': {
      if (values.length !== 1) {
        throw new Error('ISTEXT expects exactly one argument');
      }
      return typeof values[0] === 'string' && values[0] !== '';
    }
    // Math functions
    case 'SQRT': {
      if (values.length !== 1) {
        throw new Error('SQRT expects exactly one argument');
      }
      const num = coerceNumber(values[0]);
      if (num < 0) {
        throw new Error('SQRT: Cannot take square root of negative number');
      }
      return Math.sqrt(num);
    }
    case 'POWER':
    case 'POW': {
      if (values.length !== 2) {
        throw new Error('POWER expects exactly two arguments');
      }
      return Math.pow(coerceNumber(values[0]), coerceNumber(values[1]));
    }
    case 'MOD': {
      if (values.length !== 2) {
        throw new Error('MOD expects exactly two arguments');
      }
      const divisor = coerceNumber(values[1]);
      if (divisor === 0) {
        throw new Error('MOD: Division by zero');
      }
      return coerceNumber(values[0]) % divisor;
    }
    case 'INT': {
      if (values.length !== 1) {
        throw new Error('INT expects exactly one argument');
      }
      return Math.floor(coerceNumber(values[0]));
    }
    case 'SIGN': {
      if (values.length !== 1) {
        throw new Error('SIGN expects exactly one argument');
      }
      return Math.sign(coerceNumber(values[0]));
    }
    case 'PI': {
      return Math.PI;
    }
    case 'RAND': {
      return Math.random();
    }
    case 'RANDBETWEEN': {
      if (values.length !== 2) {
        throw new Error('RANDBETWEEN expects exactly two arguments');
      }
      const bottom = Math.floor(coerceNumber(values[0]));
      const top = Math.floor(coerceNumber(values[1]));
      if (bottom > top) {
        throw new Error('RANDBETWEEN: bottom must be less than or equal to top');
      }
      return Math.floor(Math.random() * (top - bottom + 1)) + bottom;
    }
    default:
      throw new Error(`Unsupported function ${upperName}`);
  }
}

function collectDependencies(node: ASTNode): string[] {
  const references = new Set<string>();

  const visit = (current: ASTNode) => {
    switch (current.type) {
      case 'CellReference': {
        const normalized = normalizeDependencyReference(current.reference);
        if (normalized) {
          references.add(normalized);
        }
        break;
      }
      case 'Range': {
        const expanded = expandRange(current.start.reference, current.end.reference);
        for (const address of expanded) {
          const normalized = normalizeDependencyReference(address);
          if (normalized) {
            references.add(normalized);
          }
        }
        break;
      }
      case 'ExternalCellReference': {
        const formatted = formatExternalReference(current.page, current.reference);
        const normalized = normalizeDependencyReference(formatted);
        if (normalized) {
          references.add(normalized);
        }
        break;
      }
      case 'ExternalRange': {
        const expanded = expandRange(current.start.reference, current.end.reference);
        for (const address of expanded) {
          const formatted = formatExternalReference(current.page, address);
          const normalized = normalizeDependencyReference(formatted);
          if (normalized) {
            references.add(normalized);
          }
        }
        break;
      }
      case 'UnaryExpression': {
        visit(current.argument);
        break;
      }
      case 'BinaryExpression': {
        visit(current.left);
        visit(current.right);
        break;
      }
      case 'FunctionCall': {
        for (const arg of current.args) {
          visit(arg);
        }
        break;
      }
      default:
        break;
    }
  };

  visit(node);
  return Array.from(references);
}

interface NodeEvaluationContext {
  getCell: (reference: string, ancestors: AncestorSet) => SheetEvaluationCell;
  getExternalCell: (
    page: SheetExternalReferenceToken,
    reference: string,
    ancestors: AncestorSet
  ) => SheetEvaluationCell;
}

function evaluateNode(node: ASTNode, context: NodeEvaluationContext, ancestors: AncestorSet): EvalValue {
  switch (node.type) {
    case 'NumberLiteral':
      return node.value;
    case 'StringLiteral':
      return node.value;
    case 'BooleanLiteral':
      return node.value;
    case 'CellReference': {
      const cell = context.getCell(node.reference, ancestors);
      if (cell.error) {
        throw new Error(cell.error);
      }
      return cell.value;
    }
    case 'Range': {
      const addresses = expandRange(node.start.reference, node.end.reference);
      return addresses.map((address) => {
        const cell = context.getCell(address, ancestors);
        if (cell.error) {
          throw new Error(cell.error);
        }
        return cell.value;
      });
    }
    case 'ExternalCellReference': {
      const cell = context.getExternalCell(node.page, node.reference, ancestors);
      if (cell.error) {
        throw new Error(cell.error);
      }
      return cell.value;
    }
    case 'ExternalRange': {
      const addresses = expandRange(node.start.reference, node.end.reference);
      return addresses.map((address) => {
        const cell = context.getExternalCell(node.page, address, ancestors);
        if (cell.error) {
          throw new Error(cell.error);
        }
        return cell.value;
      });
    }
    case 'UnaryExpression': {
      const argument = evaluateNode(node.argument, context, ancestors);
      const value = flattenValue(argument)[0];
      const numeric = coerceNumber(value);
      return node.operator === '-' ? -numeric : numeric;
    }
    case 'BinaryExpression': {
      const leftValue = flattenValue(evaluateNode(node.left, context, ancestors))[0];
      const rightValue = flattenValue(evaluateNode(node.right, context, ancestors))[0];

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
      return evaluateFunction(node.name, node.args, (child) => evaluateNode(child, context, ancestors));
    }
    default:
      throw new Error('Unsupported expression');
  }
}

const LOCAL_PAGE_KEY = '__LOCAL_PAGE__';

interface EvaluationEnvironment {
  options: SheetEvaluationOptions;
  caches: Map<string, Map<SheetCellAddress, SheetEvaluationCell>>;
  sheets: Map<string, SheetData>;
  pageTitles: Map<string, string>;
  resolutionCache: Map<string, SheetExternalReferenceResolution>;
}

function getPageCache(
  env: EvaluationEnvironment,
  pageKey: string
): Map<SheetCellAddress, SheetEvaluationCell> {
  let cache = env.caches.get(pageKey);
  if (!cache) {
    cache = new Map();
    env.caches.set(pageKey, cache);
  }
  return cache;
}

function getSheetForPage(env: EvaluationEnvironment, pageKey: string): SheetData {
  const sheet = env.sheets.get(pageKey);
  if (!sheet) {
    throw new Error(`Missing sheet data for page ${pageKey}`);
  }
  return sheet;
}

function formatAncestorKey(pageKey: string, address: SheetCellAddress): string {
  return `${pageKey}|${address}`;
}

function resolveExternalSheet(
  page: SheetExternalReferenceToken,
  env: EvaluationEnvironment
): SheetExternalReferenceResolution {
  if (env.resolutionCache.has(page.raw)) {
    return env.resolutionCache.get(page.raw)!;
  }

  if (!env.options.resolveExternalReference) {
    const fallback: SheetExternalReferenceResolution = {
      pageId: page.identifier ?? page.raw,
      pageTitle: page.label,
      error: 'Cross-page references are not supported in this context',
    };
    env.resolutionCache.set(page.raw, fallback);
    return fallback;
  }

  const provided = env.options.resolveExternalReference(page);
  if (!provided) {
    const fallback: SheetExternalReferenceResolution = {
      pageId: page.identifier ?? page.raw,
      pageTitle: page.label,
      error: `Referenced page "${page.label}" is not available`,
    };
    env.resolutionCache.set(page.raw, fallback);
    return fallback;
  }

  const normalized: SheetExternalReferenceResolution = {
    pageId: provided.pageId || page.identifier || page.raw,
    pageTitle: provided.pageTitle || page.label,
    sheet: provided.sheet,
    error: provided.error,
  };

  env.resolutionCache.set(page.raw, normalized);

  if (normalized.sheet) {
    env.sheets.set(normalized.pageId, normalized.sheet);
    if (!env.caches.has(normalized.pageId)) {
      env.caches.set(normalized.pageId, new Map());
    }
    if (!env.pageTitles.has(normalized.pageId)) {
      env.pageTitles.set(normalized.pageId, normalized.pageTitle);
    }
  }

  return normalized;
}

function evaluateExternalReferenceCell(
  page: SheetExternalReferenceToken,
  address: SheetCellAddress,
  env: EvaluationEnvironment,
  ancestors: AncestorSet
): SheetEvaluationCell {
  const resolution = resolveExternalSheet(page, env);
  if (!resolution.sheet || resolution.error) {
    return {
      address: address.toUpperCase(),
      raw: '',
      value: '',
      display: '#ERROR',
      type: 'empty',
      error:
        resolution.error ?? `Referenced page "${page.label}" is not available`,
      dependsOn: [],
      dependents: [],
    };
  }

  return evaluateCellInternal(address, resolution.pageId, env, ancestors);
}

function evaluateCellInternal(
  address: SheetCellAddress,
  pageKey: string,
  env: EvaluationEnvironment,
  ancestors: AncestorSet
): SheetEvaluationCell {
  const normalized = address.toUpperCase();
  const cache = getPageCache(env, pageKey);

  if (cache.has(normalized)) {
    return cache.get(normalized)!;
  }

  const ancestorKey = formatAncestorKey(pageKey, normalized);
  if (ancestors.has(ancestorKey)) {
    const sheet = getSheetForPage(env, pageKey);
    const circular: SheetEvaluationCell = {
      address: normalized,
      raw: sheet.cells[normalized] ?? '',
      value: '',
      display: '#CYCLE',
      type: 'empty',
      error: 'Circular reference detected',
      dependsOn: [],
      dependents: [],
    };
    cache.set(normalized, circular);
    return circular;
  }

  const sheet = getSheetForPage(env, pageKey);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(ancestorKey);

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
      dependsOn: [],
      dependents: [],
    };
  } else if (trimmed.startsWith('=')) {
    const formula = trimmed.slice(1);
    let dependencies: string[] = [];
    try {
      const tokens = tokenize(formula);
      if (tokens.length === 0) {
        throw new Error('Empty formula');
      }
      const parser = new FormulaParser(tokens);
      const ast = parser.parse();
      dependencies = uniqueSorted(collectDependencies(ast));
      const evaluated = evaluateNode(
        ast,
        {
          getCell: (reference, ancestorsSet) =>
            evaluateCellInternal(reference, pageKey, env, ancestorsSet),
          getExternalCell: (pageRef, reference, ancestorsSet) =>
            evaluateExternalReferenceCell(pageRef, reference, env, ancestorsSet),
        },
        nextAncestors
      );
      const value = flattenValue(evaluated)[0];
      const type =
        value === ''
          ? 'empty'
          : typeof value === 'number'
          ? 'number'
          : typeof value === 'boolean'
          ? 'boolean'
          : 'string';
      result = {
        address: normalized,
        raw: rawInput,
        value,
        display: formatDisplayValue(value),
        type,
        dependsOn: dependencies,
        dependents: [],
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
        dependsOn: dependencies,
        dependents: [],
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
      dependsOn: [],
      dependents: [],
    };
  } else {
    result = {
      address: normalized,
      raw: rawInput,
      value: rawInput,
      display: rawInput,
      type: 'string',
      dependsOn: [],
      dependents: [],
    };
  }

  cache.set(normalized, result);
  return result;
}

export function evaluateSheet(
  sheet: SheetData,
  options: SheetEvaluationOptions = {}
): SheetEvaluation {
  const rowCount = Math.max(1, sheet.rowCount);
  const columnCount = Math.max(1, sheet.columnCount);
  const pageKey = options.pageId ?? LOCAL_PAGE_KEY;
  const env: EvaluationEnvironment = {
    options,
    caches: new Map([[pageKey, new Map()]]),
    sheets: new Map([[pageKey, sheet]]),
    pageTitles: new Map([[pageKey, options.pageTitle ?? 'Sheet']]),
    resolutionCache: new Map(),
  };
  const byAddress: Record<string, SheetEvaluationCell> = {};
  const display: string[][] = Array.from({ length: rowCount }, () => Array(columnCount).fill(''));
  const errors: (string | null)[][] = Array.from({ length: rowCount }, () => Array(columnCount).fill(null));

  for (let row = 0; row < rowCount; row++) {
    for (let column = 0; column < columnCount; column++) {
      const address = encodeCellAddress(row, column);
      const cell = evaluateCellInternal(address, pageKey, env, new Set());
      byAddress[address] = cell;
      display[row][column] = cell.error ? '#ERROR' : cell.display;
      errors[row][column] = cell.error ?? null;
    }
  }

  for (const cell of Object.values(byAddress)) {
    for (const dependency of cell.dependsOn) {
      const target = byAddress[dependency];
      if (!target) {
        continue;
      }
      if (!target.dependents.includes(cell.address)) {
        target.dependents = [...target.dependents, cell.address];
      }
    }
  }

  const dependencies: Record<string, SheetDocDependencyRecord> = {};

  for (const cell of Object.values(byAddress)) {
    cell.dependsOn = uniqueSorted(cell.dependsOn);
    cell.dependents = uniqueSorted(cell.dependents);
    dependencies[cell.address] = {
      dependsOn: cell.dependsOn,
      dependents: cell.dependents,
    };
  }

  return {
    byAddress,
    display,
    errors,
    dependencies,
  };
}

function collectExternalReferencesFromNode(
  node: ASTNode,
  references: Map<string, SheetExternalReferenceToken>
): void {
  switch (node.type) {
    case 'ExternalCellReference':
      if (!references.has(node.page.raw)) {
        references.set(node.page.raw, node.page);
      }
      break;
    case 'ExternalRange':
      if (!references.has(node.page.raw)) {
        references.set(node.page.raw, node.page);
      }
      break;
    case 'UnaryExpression':
      collectExternalReferencesFromNode(node.argument, references);
      break;
    case 'BinaryExpression':
      collectExternalReferencesFromNode(node.left, references);
      collectExternalReferencesFromNode(node.right, references);
      break;
    case 'FunctionCall':
      for (const arg of node.args) {
        collectExternalReferencesFromNode(arg, references);
      }
      break;
    default:
      break;
  }
}

export function collectExternalReferences(
  sheet: SheetData
): SheetExternalReferenceToken[] {
  const references = new Map<string, SheetExternalReferenceToken>();

  for (const value of Object.values(sheet.cells)) {
    const rawValue = typeof value === 'string' ? value : String(value ?? '');
    const trimmed = rawValue.trim();
    if (!trimmed.startsWith('=')) {
      continue;
    }

    const formula = trimmed.slice(1);
    try {
      const tokens = tokenize(formula);
      if (tokens.length === 0) {
        continue;
      }
      const parser = new FormulaParser(tokens);
      const ast = parser.parse();
      collectExternalReferencesFromNode(ast, references);
    } catch {
      continue;
    }
  }

  return Array.from(references.values());
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

/**
 * Cell update interface for batch editing
 */
export interface SheetCellUpdate {
  address: string;
  value: string;
}

/**
 * Validates a cell address is in valid A1 format
 */
export function isValidCellAddress(address: string): boolean {
  const normalized = address.trim().toUpperCase();
  return cellRegex.test(normalized);
}

/**
 * Update multiple cells in a SheetData object
 * Returns a new SheetData with the updated cells
 */
export function updateSheetCells(
  sheet: SheetData,
  updates: SheetCellUpdate[]
): SheetData {
  // Clone the cells to avoid mutation
  const newCells = cloneCells(sheet.cells);
  let maxRow = sheet.rowCount;
  let maxColumn = sheet.columnCount;

  for (const update of updates) {
    const normalizedAddress = update.address.trim().toUpperCase();

    // Validate cell address
    if (!cellRegex.test(normalizedAddress)) {
      throw new Error(`Invalid cell address: "${update.address}". Use A1-style format (e.g., A1, B2, AA100).`);
    }

    // Update the cell
    const trimmedValue = update.value.trim();
    if (trimmedValue === '') {
      // Empty value - remove the cell
      delete newCells[normalizedAddress];
    } else {
      newCells[normalizedAddress] = update.value;
    }

    // Track max row/column to potentially expand the sheet
    try {
      const { row, column } = decodeCellAddress(normalizedAddress);
      maxRow = Math.max(maxRow, row + 1);
      maxColumn = Math.max(maxColumn, column + 1);
    } catch {
      // If decode fails, we already validated above, so this shouldn't happen
    }
  }

  return {
    ...sheet,
    rowCount: maxRow,
    columnCount: maxColumn,
    cells: newCells,
  };
}
