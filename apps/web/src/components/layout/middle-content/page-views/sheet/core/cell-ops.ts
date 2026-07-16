import { type SheetData } from '@pagespace/lib/sheets/sheet';

/**
 * Pure cell-mutation core for the sheet view. Every function returns a new
 * SheetData with a bumped version and never mutates its input — the four
 * near-identical write/delete blocks in SheetView collapse onto these.
 */

/** Whether a key should trigger direct in-cell editing (a printable char or F2). */
export const isPrintableKey = (key: string): boolean => {
  if (key.length === 1 && /[\x20-\x7E]/.test(key)) {
    return true;
  }
  return key === 'F2';
};

/**
 * Write a value to a cell. A whitespace-only value deletes the cell instead of
 * storing blank content; otherwise the raw (untrimmed) value is stored.
 */
export const applyCellWrite = (previous: SheetData, address: string, value: string): SheetData => {
  const nextCells = { ...previous.cells };
  if (value.trim() === '') {
    delete nextCells[address];
  } else {
    nextCells[address] = value;
  }
  return {
    ...previous,
    version: previous.version + 1,
    cells: nextCells,
  };
};

/** Delete a cell, leaving the rest of the grid untouched. */
export const applyCellDelete = (previous: SheetData, address: string): SheetData => {
  const nextCells = { ...previous.cells };
  delete nextCells[address];
  return {
    ...previous,
    version: previous.version + 1,
    cells: nextCells,
  };
};

/**
 * The value an edit should start with, given the current cell content and the
 * key that triggered it: a typed printable character replaces the content;
 * F2 (or no key) edits from the current value.
 */
export const initialEditValueForKey = (currentValue: string, key?: string): string => {
  if (key === 'F2') {
    return currentValue;
  }
  if (key && isPrintableKey(key) && key.length === 1) {
    return key;
  }
  return currentValue;
};

/** Append a row. */
export const addRow = (previous: SheetData): SheetData => ({
  ...previous,
  version: previous.version + 1,
  rowCount: previous.rowCount + 1,
});

/** Append a column. */
export const addColumn = (previous: SheetData): SheetData => ({
  ...previous,
  version: previous.version + 1,
  columnCount: previous.columnCount + 1,
});
