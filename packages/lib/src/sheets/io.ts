/**
 * @module @pagespace/lib/sheets/io
 * @description Sheet serialization and deserialization
 */

import { parse as parseToml } from '@iarna/toml';

import type {
  SheetData,
  SheetDoc,
  SheetDocCell,
  SheetDocCellError,
  SheetDocSheet,
  SheetDocDependencyRecord,
  SheetPrimitive,
} from './types';
import { SHEETDOC_MAGIC, SHEETDOC_VERSION, SHEET_VERSION, SHEET_DEFAULT_ROWS, SHEET_DEFAULT_COLUMNS } from './constants';
import { evaluateSheet } from './evaluation';
import { sanitizeSheetData } from './update';
import { cellRegex } from './address';

/**
 * Create an empty sheet with default dimensions
 */
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

/**
 * Parse sheet content from various formats
 */
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

/**
 * Serialize sheet content to TOML format
 */
export function serializeSheetContent(
  sheet: SheetData,
  options: { pageId?: string; sheetName?: string } = {}
): string {
  const sanitized = sanitizeSheetData({ ...sheet });
  const evaluation = evaluateSheet(sanitized);
  const doc = sheetDataToSheetDoc(sanitized, evaluation, options);
  return stringifySheetDoc(doc);
}

/**
 * Check if a string is in SheetDoc format
 */
export function isSheetDocString(value: string): boolean {
  return value.trimStart().startsWith(SHEETDOC_MAGIC);
}

/**
 * Parse a SheetDoc string to a SheetDoc object
 */
export function parseSheetDocString(value: string): SheetDoc {
  const lines = value.split(/\r?\n/);
  let headerIndex = -1;

  for (let index = 0; index < lines.length; index++) {
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

/**
 * Convert SheetDoc to SheetData
 */
export function sheetDataFromSheetDoc(doc: SheetDoc): SheetData {
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

/**
 * Stringify a SheetDoc to TOML format
 */
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

// Internal helper functions

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

    const cells: Record<string, SheetDocCell> = {};
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

    const dependencies: Record<string, SheetDocDependencyRecord> = {};
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

function sheetDataToSheetDoc(
  sheet: SheetData,
  evaluation: ReturnType<typeof evaluateSheet>,
  options: { pageId?: string; sheetName?: string }
): SheetDoc {
  const sheetName = options.sheetName ?? 'Sheet1';
  const cells: Record<string, SheetDocCell> = {};
  const dependencies: Record<string, SheetDocDependencyRecord> = {};
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

function normalizeCellAddress(address: string | undefined): string | null {
  if (!address) {
    return null;
  }

  const upper = address.trim().toUpperCase();
  return cellRegex.test(upper) ? upper : null;
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

  const match = trimmed.match(
    /^@\[(?<label>[^\]]+)\](?:\((?<identifier>[^):]+)(?::(?<mentionType>[^)]+))?\))?:(?<address>[A-Z]+\d+)$/i
  );
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

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
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

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

function toSnakeCase(value: string): string {
  return value.replace(/([A-Z])/g, '_$1').toLowerCase();
}
