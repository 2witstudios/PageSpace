/**
 * @module @pagespace/lib/sheets/update
 * @description Cell update and sanitization utilities
 */

import { PageType } from '../utils/enums';
import type { CellFormat, SheetData, SheetCellUpdate } from './types';
import { cellRegex, decodeCellAddress } from './address';
import { parseCellFormat } from './format';

/**
 * Clone cells record
 */
export function cloneCells(cells: Record<string, string>): Record<string, string> {
  return { ...cells };
}

/**
 * Sanitize sheet data - remove invalid cells
 * Note: This function does not depend on io.ts to avoid circular dependencies
 */
export function sanitizeSheetData(sheet: SheetData): SheetData {
  const sanitizedCells = cloneCells(sheet.cells);

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
    ...sheet,
    rowCount: Math.max(1, sheet.rowCount),
    columnCount: Math.max(1, sheet.columnCount),
    cells: sanitizedCells,
    formats: sanitizeFormats(sheet.formats),
    columnFormats: sanitizeKeyedFormats(sheet.columnFormats, columnKeyRegex),
    columnWidths: sanitizeKeyedNumbers(sheet.columnWidths, columnKeyRegex),
    rowHeights: sanitizeKeyedNumbers(sheet.rowHeights, rowKeyRegex),
  };
}

const columnKeyRegex = /^[A-Z]+$/;
const rowKeyRegex = /^[1-9]\d*$/;

/**
 * Drop format entries whose address is not a valid A1 reference.
 *
 * Entries that are merely *outside* the current row/column count are kept on
 * purpose: a sheet that temporarily shrinks — or one whose formatting was
 * applied ahead of its data — must not lose its styling, and the grid simply
 * ignores formats it cannot show.
 */
function sanitizeFormats(
  formats: Record<string, CellFormat> | undefined
): Record<string, CellFormat> | undefined {
  if (!formats) return undefined;

  const sanitized: Record<string, CellFormat> = {};

  for (const [key, format] of Object.entries(formats)) {
    const normalized = key.toUpperCase();
    if (!cellRegex.test(normalized)) continue;

    // Validate the format itself, not just its address. The read path runs
    // `parseCellFormat` and drops anything non-conforming, so skipping it here
    // let the write path persist a format that vanished on the next load.
    const parsed = parseCellFormat(format);
    if (parsed) sanitized[normalized] = parsed;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

/** Per-column/row format maps, keyed by column letters or a row number. */
function sanitizeKeyedFormats(
  formats: Record<string, CellFormat> | undefined,
  keyPattern: RegExp
): Record<string, CellFormat> | undefined {
  if (!formats) return undefined;

  const sanitized: Record<string, CellFormat> = {};

  for (const [key, format] of Object.entries(formats)) {
    const normalized = key.toUpperCase();
    if (!keyPattern.test(normalized)) continue;

    const parsed = parseCellFormat(format);
    if (parsed) sanitized[normalized] = parsed;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

/** Per-column/row size maps; these reach the serializer unchecked otherwise. */
function sanitizeKeyedNumbers(
  values: Record<string, number> | undefined,
  keyPattern: RegExp
): Record<string, number> | undefined {
  if (!values) return undefined;

  const sanitized: Record<string, number> = {};

  for (const [key, value] of Object.entries(values)) {
    const normalized = key.toUpperCase();
    if (!keyPattern.test(normalized)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    sanitized[normalized] = Math.round(value);
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

/**
 * Check if a page type is a sheet
 */
export function isSheetType(type: PageType): boolean {
  return type === PageType.SHEET;
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
