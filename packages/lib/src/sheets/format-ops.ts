/**
 * @module @pagespace/lib/sheets/format-ops
 * @description The single mutation surface for a sheet's presentation maps.
 *
 * Formats, column widths and row heights live in maps parallel to `cells`
 * rather than inside the cell values. That keeps every existing consumer of
 * `cells` working unchanged and makes "clear contents, keep formatting" the
 * natural behaviour — but it also means the two can drift apart if a future
 * structural edit (insert/delete row or column) moves cells without moving
 * their metadata. Routing every write through this module, and through
 * `moveCellMetadata` in particular, is what keeps them in step.
 */

import type { CellFormat, SheetData } from './types';
import { isEmptyFormat, resolveCellFormat } from './format';
import { cellRegex, decodeCellAddress, encodeCellAddress } from './address';

const normalizeAddress = (address: string): string | null => {
  const normalized = address.trim().toUpperCase();
  return cellRegex.test(normalized) ? normalized : null;
};

const columnLettersOf = (address: string): string => address.replace(/\d+$/, '');

/** Column letters for a 0-based column index ("A", "AB"). */
export const columnKeyFromIndex = (index: number): string =>
  columnLettersOf(encodeCellAddress(0, index));

/** The format in force for a cell, with the column default already applied. */
export function getEffectiveCellFormat(
  sheet: SheetData,
  address: string
): CellFormat | undefined {
  const normalized = normalizeAddress(address);
  if (!normalized) return undefined;

  return resolveCellFormat(
    sheet.formats?.[normalized],
    sheet.columnFormats?.[columnLettersOf(normalized)]
  );
}

const withFormats = (
  sheet: SheetData,
  formats: Record<string, CellFormat>
): SheetData => ({
  ...sheet,
  version: sheet.version + 1,
  formats: Object.keys(formats).length > 0 ? formats : undefined,
});

/**
 * Merge `patch` into the format of each address. A field set to `undefined`
 * clears that field, so a toolbar can turn bold off without dropping the rest
 * of the cell's styling.
 */
export function setCellFormats(
  sheet: SheetData,
  addresses: readonly string[],
  patch: CellFormat
): SheetData {
  const formats = { ...(sheet.formats ?? {}) };

  for (const address of addresses) {
    const normalized = normalizeAddress(address);
    if (!normalized) continue;

    const merged: CellFormat = { ...(formats[normalized] ?? {}), ...patch };
    for (const key of Object.keys(merged) as Array<keyof CellFormat>) {
      if (merged[key] === undefined) delete merged[key];
    }

    if (isEmptyFormat(merged)) {
      delete formats[normalized];
    } else {
      formats[normalized] = merged;
    }
  }

  return withFormats(sheet, formats);
}

/** Remove all formatting from the given cells, leaving their values alone. */
export function clearCellFormats(sheet: SheetData, addresses: readonly string[]): SheetData {
  const formats = { ...(sheet.formats ?? {}) };

  for (const address of addresses) {
    const normalized = normalizeAddress(address);
    if (normalized) delete formats[normalized];
  }

  return withFormats(sheet, formats);
}

/** Set a column-wide default format, which individual cells may override. */
export function setColumnFormat(
  sheet: SheetData,
  columnIndex: number,
  patch: CellFormat
): SheetData {
  const key = columnKeyFromIndex(columnIndex);
  const columnFormats = { ...(sheet.columnFormats ?? {}) };
  const merged: CellFormat = { ...(columnFormats[key] ?? {}), ...patch };

  for (const field of Object.keys(merged) as Array<keyof CellFormat>) {
    if (merged[field] === undefined) delete merged[field];
  }

  if (isEmptyFormat(merged)) {
    delete columnFormats[key];
  } else {
    columnFormats[key] = merged;
  }

  return {
    ...sheet,
    version: sheet.version + 1,
    columnFormats: Object.keys(columnFormats).length > 0 ? columnFormats : undefined,
  };
}

export const MIN_COLUMN_WIDTH = 24;
export const MAX_COLUMN_WIDTH = 2000;
export const MIN_ROW_HEIGHT = 16;
export const MAX_ROW_HEIGHT = 1000;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

/** Set a column's width in px, or clear it by passing `undefined`. */
export function setColumnWidth(
  sheet: SheetData,
  columnIndex: number,
  width: number | undefined
): SheetData {
  const key = columnKeyFromIndex(columnIndex);
  const columnWidths = { ...(sheet.columnWidths ?? {}) };

  if (width === undefined || !Number.isFinite(width)) {
    delete columnWidths[key];
  } else {
    columnWidths[key] = clamp(width, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
  }

  return {
    ...sheet,
    version: sheet.version + 1,
    columnWidths: Object.keys(columnWidths).length > 0 ? columnWidths : undefined,
  };
}

/** Set a row's height in px, or clear it by passing `undefined`. */
export function setRowHeight(
  sheet: SheetData,
  rowIndex: number,
  height: number | undefined
): SheetData {
  const key = String(rowIndex + 1);
  const rowHeights = { ...(sheet.rowHeights ?? {}) };

  if (height === undefined || !Number.isFinite(height)) {
    delete rowHeights[key];
  } else {
    rowHeights[key] = clamp(height, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT);
  }

  return {
    ...sheet,
    version: sheet.version + 1,
    rowHeights: Object.keys(rowHeights).length > 0 ? rowHeights : undefined,
  };
}

/** Freeze the first `rows` rows and `columns` columns (0 disables). */
export function setFrozen(
  sheet: SheetData,
  rows: number | undefined,
  columns: number | undefined
): SheetData {
  const normalize = (value: number | undefined): number | undefined => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
    return Math.trunc(value);
  };

  return {
    ...sheet,
    version: sheet.version + 1,
    frozenRows: normalize(rows),
    frozenColumns: normalize(columns),
  };
}

/**
 * Relocate PER-CELL metadata when cells move.
 *
 * **Any structural edit that moves cells must call this**, or a sheet's
 * formatting will stay behind while its values shift — inserting a row would
 * leave every colour and number format one row out of place. `addressMap` maps
 * an old A1 address to its new one; an address absent from the map keeps its
 * position, and one mapped to `null` is being deleted.
 *
 * Scope: this moves `formats` only. Per-COLUMN and per-ROW metadata
 * (`columnFormats`, `columnWidths`, `rowHeights`) is keyed by column letters
 * and row numbers, not by cell address, so it cannot be expressed as an
 * address map — see {@link shiftAxisMetadata}, which a structural edit must
 * also call.
 */
export function moveCellMetadata(
  sheet: SheetData,
  addressMap: ReadonlyMap<string, string | null>
): SheetData {
  if (!sheet.formats || Object.keys(sheet.formats).length === 0) {
    return sheet;
  }

  const formats: Record<string, CellFormat> = {};

  for (const [address, format] of Object.entries(sheet.formats)) {
    if (!addressMap.has(address)) {
      formats[address] = format;
      continue;
    }

    const target = addressMap.get(address);
    if (target === null || target === undefined) continue;

    const normalized = normalizeAddress(target);
    if (normalized) formats[normalized] = format;
  }

  return {
    ...sheet,
    formats: Object.keys(formats).length > 0 ? formats : undefined,
  };
}

/**
 * Shift per-column and per-row metadata for a structural insert or delete.
 *
 * The companion to {@link moveCellMetadata}: column widths and column default
 * formats are keyed by column letters, and row heights by row number, so an
 * inserted column must renumber them or every column past the insertion point
 * keeps the width of its neighbour.
 *
 * `at` is a 0-based index on `axis`; `delta` is positive to insert and
 * negative to delete. Entries inside a deleted band are dropped.
 */
export function shiftAxisMetadata(
  sheet: SheetData,
  axis: 'row' | 'column',
  at: number,
  delta: number
): SheetData {
  if (delta === 0) return sheet;

  const shiftKeyed = <T,>(
    source: Record<string, T> | undefined,
    indexOf: (key: string) => number | null,
    keyOf: (index: number) => string
  ): Record<string, T> | undefined => {
    if (!source) return undefined;

    const shifted: Record<string, T> = {};
    for (const [key, value] of Object.entries(source)) {
      const index = indexOf(key);
      if (index === null) continue;

      if (index < at) {
        shifted[key] = value;
        continue;
      }
      // Inside a deleted band: the column or row is gone, so its metadata is too.
      if (delta < 0 && index < at - delta) continue;

      shifted[keyOf(index + delta)] = value;
    }

    return Object.keys(shifted).length > 0 ? shifted : undefined;
  };

  if (axis === 'column') {
    const indexOf = (key: string) => columnIndexOfAddress(`${key}1`);
    return {
      ...sheet,
      version: sheet.version + 1,
      columnWidths: shiftKeyed(sheet.columnWidths, indexOf, columnKeyFromIndex),
      columnFormats: shiftKeyed(sheet.columnFormats, indexOf, columnKeyFromIndex),
    };
  }

  const rowIndexOf = (key: string) => {
    const parsed = Number(key);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed - 1 : null;
  };

  return {
    ...sheet,
    version: sheet.version + 1,
    rowHeights: shiftKeyed(sheet.rowHeights, rowIndexOf, (index) => String(index + 1)),
  };
}

/** Every A1 address in an inclusive rectangle, row-major. */
export function addressesInRange(
  start: { row: number; column: number },
  end: { row: number; column: number }
): string[] {
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

/** The column index of an A1 address, or null if it is not one. */
export function columnIndexOfAddress(address: string): number | null {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;

  try {
    return decodeCellAddress(normalized).column;
  } catch {
    return null;
  }
}
