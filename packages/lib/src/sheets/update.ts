/**
 * @module @pagespace/lib/sheets/update
 * @description Cell update and sanitization utilities
 */

import { PageType } from '../utils/enums';
import type { SheetData, SheetCellUpdate } from './types';
import { cellRegex, decodeCellAddress } from './address';

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
    cells: sanitizedCells,
  };
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
