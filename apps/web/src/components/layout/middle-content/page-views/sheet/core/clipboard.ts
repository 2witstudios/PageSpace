import {
  adjustFormulaReferences,
  encodeCellAddress,
  type SheetData,
} from '@pagespace/lib/sheets/sheet';
import type { GridSelection, SelectionState } from './selection';

/**
 * Pure clipboard core for the sheet view: parse pasted text into a grid, build
 * the copy payload for a selection, and compute the cell mutation for a paste
 * (including formula-reference offset adjustment). No DOM/clipboard access —
 * the shell hook reads/writes `navigator.clipboard` and calls these.
 */

export type CopyMode = 'formulas' | 'values';
export type PasteMode = 'auto' | CopyMode;

export interface ParsedClipboard {
  data: string[][];
  rows: number;
  columns: number;
}

/** Detect the table structure of pasted text (tab, then comma, then single column). */
export const parseClipboardData = (text: string): ParsedClipboard | null => {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  let cells: string[][];

  const hasTabSeparation = lines.some((line) => line.includes('\t'));
  if (hasTabSeparation) {
    cells = lines.map((line) => line.split('\t'));
  } else {
    const hasCommaSeparation = lines.some((line) => line.includes(','));
    if (hasCommaSeparation) {
      cells = lines.map((line) => line.split(',').map((cell) => cell.trim()));
    } else {
      cells = lines.map((line) => [line]);
    }
  }

  const maxColumns = Math.max(...cells.map((row) => row.length));

  // Pad rows to a consistent column count.
  const padded = cells.map((row) => {
    const next = [...row];
    while (next.length < maxColumns) {
      next.push('');
    }
    return next;
  });

  return {
    data: padded,
    rows: padded.length,
    columns: maxColumns,
  };
};

export interface CopyPayload {
  data: string;
  cellCount: number;
}

/** Build the clipboard text for a selection: raw formulas or evaluated display values. */
export const buildCopyPayload = (
  selection: SelectionState,
  sheet: SheetData,
  display: string[][],
  mode: CopyMode,
): CopyPayload => {
  if (selection.type === 'single') {
    const { row, column } = selection.cell;
    const data =
      mode === 'formulas'
        ? sheet.cells[encodeCellAddress(row, column)] ?? ''
        : display[row]?.[column] ?? '';
    return { data, cellCount: 1 };
  }

  const { start, end } = selection.range;
  const minRow = Math.min(start.row, end.row);
  const maxRow = Math.max(start.row, end.row);
  const minCol = Math.min(start.column, end.column);
  const maxCol = Math.max(start.column, end.column);

  const rows: string[] = [];
  for (let row = minRow; row <= maxRow; row++) {
    const cols: string[] = [];
    for (let col = minCol; col <= maxCol; col++) {
      if (mode === 'formulas') {
        cols.push(sheet.cells[encodeCellAddress(row, col)] ?? '');
      } else {
        cols.push(display[row]?.[col] ?? '');
      }
    }
    rows.push(cols.join('\t'));
  }

  const cellCount = (maxRow - minRow + 1) * (maxCol - minCol + 1);
  return { data: rows.join('\n'), cellCount };
};

/** Resolve an `auto` paste to a concrete mode: internal pastes reuse the copied mode, external force values. */
export const resolvePasteMode = (
  requested: PasteMode,
  isInternalPaste: boolean,
  copiedMode: CopyMode | undefined,
): CopyMode => {
  if (requested !== 'auto') {
    return requested;
  }
  if (isInternalPaste) {
    return copiedMode ?? 'values';
  }
  return 'values';
};

export interface ComputePasteParams {
  previous: SheetData;
  table: ParsedClipboard;
  start: GridSelection;
  pasteMode: CopyMode;
  isInternalPaste: boolean;
  /** The top-left cell of the original copy, required to offset internal formula pastes. */
  copyStart?: GridSelection;
}

/** Apply a paste to a sheet, returning a new SheetData (never mutating `previous`). */
export const computePasteCells = ({
  previous,
  table,
  start,
  pasteMode,
  isInternalPaste,
  copyStart,
}: ComputePasteParams): SheetData => {
  const nextCells = { ...previous.cells };

  const rowOffset = copyStart ? start.row - copyStart.row : 0;
  const colOffset = copyStart ? start.column - copyStart.column : 0;

  for (let row = 0; row < table.rows; row++) {
    for (let col = 0; col < table.columns; col++) {
      const cellAddress = encodeCellAddress(start.row + row, start.column + col);
      let value = table.data[row][col].trim();

      if (value === '') {
        delete nextCells[cellAddress];
        continue;
      }

      if (pasteMode === 'formulas' && isInternalPaste && value.startsWith('=')) {
        if (rowOffset !== 0 || colOffset !== 0) {
          value = adjustFormulaReferences(value, rowOffset, colOffset);
        }
      } else if (pasteMode === 'values' && value.startsWith('=')) {
        // Values mode never pastes a formula; leave the existing target as-is.
        continue;
      }

      nextCells[cellAddress] = value;
    }
  }

  return {
    ...previous,
    version: previous.version + 1,
    rowCount: Math.max(previous.rowCount, start.row + table.rows),
    columnCount: Math.max(previous.columnCount, start.column + table.columns),
    cells: nextCells,
  };
};

/** The paste selection to show after a multi-cell paste, or null for a single cell. */
export const pasteResultSelection = (
  start: GridSelection,
  table: ParsedClipboard,
): SelectionState | null => {
  if (table.rows <= 1 && table.columns <= 1) {
    return null;
  }
  return {
    type: 'range',
    range: {
      start: { row: start.row, column: start.column },
      end: {
        row: start.row + table.rows - 1,
        column: start.column + table.columns - 1,
      },
    },
  };
};
