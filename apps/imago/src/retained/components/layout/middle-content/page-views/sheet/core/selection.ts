import { encodeCellAddress, type SheetData } from '@pagespace/lib/sheets/sheet';

/**
 * Pure selection-geometry core for the sheet view.
 *
 * All functions here are side-effect free: given a selection/cell and the grid
 * dimensions, they compute the next selection or a derived value. Nothing reads
 * the DOM, a clock, or a store — that lives in the shell hooks.
 */

export type GridSelection = {
  row: number;
  column: number;
};

export type GridRange = {
  start: GridSelection;
  end: GridSelection;
};

export type SelectionState =
  | {
      type: 'single';
      cell: GridSelection;
    }
  | {
      type: 'range';
      range: GridRange;
    };

type GridDimensions = Pick<SheetData, 'rowCount' | 'columnCount'>;

/** Clamp a cell into the grid, never returning a negative index. */
export const clampSelection = (selection: GridSelection, sheet: GridDimensions): GridSelection => ({
  row: Math.min(Math.max(selection.row, 0), Math.max(0, sheet.rowCount - 1)),
  column: Math.min(Math.max(selection.column, 0), Math.max(0, sheet.columnCount - 1)),
});

/** Clamp both endpoints of a range into the grid. */
export const clampRange = (range: GridRange, sheet: GridDimensions): GridRange => ({
  start: clampSelection(range.start, sheet),
  end: clampSelection(range.end, sheet),
});

/** The primary cell used for formula display and editing. */
export const getPrimaryCell = (selection: SelectionState): GridSelection =>
  selection.type === 'single' ? selection.cell : selection.range.start;

/** Whether a cell falls within the current selection (endpoint order agnostic). */
export const isCellInSelection = (row: number, column: number, selection: SelectionState): boolean => {
  if (selection.type === 'single') {
    return selection.cell.row === row && selection.cell.column === column;
  }

  const { start, end } = selection.range;
  const minRow = Math.min(start.row, end.row);
  const maxRow = Math.max(start.row, end.row);
  const minCol = Math.min(start.column, end.column);
  const maxCol = Math.max(start.column, end.column);

  return row >= minRow && row <= maxRow && column >= minCol && column <= maxCol;
};

/** The display address for a selection (e.g. `A1` or `A1:B2`). */
export const getSelectionAddress = (selection: SelectionState): string => {
  if (selection.type === 'single') {
    return encodeCellAddress(selection.cell.row, selection.cell.column);
  }

  const { start, end } = selection.range;
  if (start.row === end.row && start.column === end.column) {
    return encodeCellAddress(start.row, start.column);
  }

  const startAddr = encodeCellAddress(start.row, start.column);
  const endAddr = encodeCellAddress(end.row, end.column);
  return `${startAddr}:${endAddr}`;
};

/** The column-header letter label (digits stripped from the A1 address). */
export const getColumnLabel = (columnIndex: number): string =>
  encodeCellAddress(0, columnIndex).replace(/\d+/g, '');

export interface GridNavInput {
  key: string;
  shiftKey: boolean;
  isReadOnly: boolean;
}

/**
 * Navigation math for arrow / Tab / Enter keys.
 *
 * Returns the cell the grid should select, or `null` when the key is not a
 * grid-navigation key at all (the caller then leaves the event alone). A
 * non-null result means the key WAS consumed by the grid, which is why
 * read-only Enter returns the unchanged cell rather than null: the key is still
 * handled (and preventDefault'd), it just does not move the selection.
 *
 * Arrows clamp at grid edges; Tab wraps across rows; Shift+Tab wraps backwards
 * but stays put at the origin (0,0); Enter moves down (Shift+Enter up) unless
 * read-only.
 */
export const nextSelectionForKey = (
  input: GridNavInput,
  cell: GridSelection,
  sheet: GridDimensions,
): GridSelection | null => {
  let { row, column } = cell;
  const { key, shiftKey, isReadOnly } = input;

  switch (key) {
    case 'ArrowUp':
      row = Math.max(0, row - 1);
      break;
    case 'ArrowDown':
      row = Math.min(sheet.rowCount - 1, row + 1);
      break;
    case 'ArrowLeft':
      column = Math.max(0, column - 1);
      break;
    case 'ArrowRight':
      column = Math.min(sheet.columnCount - 1, column + 1);
      break;
    case 'Tab':
      if (shiftKey) {
        if (column === 0) {
          // At the very origin there is nowhere backwards to go.
          if (row === 0) {
            return { row: 0, column: 0 };
          }
          column = sheet.columnCount - 1;
          row = Math.max(0, row - 1);
        } else {
          column = Math.max(0, column - 1);
        }
      } else {
        column += 1;
        if (column >= sheet.columnCount) {
          column = 0;
          row = Math.min(sheet.rowCount - 1, row + 1);
        }
      }
      break;
    case 'Enter':
      if (!isReadOnly) {
        if (shiftKey) {
          row = Math.max(0, row - 1);
        } else {
          row = Math.min(sheet.rowCount - 1, row + 1);
        }
      }
      break;
    default:
      return null;
  }

  return { row, column };
};
