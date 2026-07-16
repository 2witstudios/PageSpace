import { encodeCellAddress, type SheetEvaluationCell } from '@pagespace/lib/sheets/sheet';
import type { SelectionState } from './selection';

/**
 * Pure selection-statistics core: sum/average/count over the selected cells,
 * reading from the evaluator's `byAddress` map. Non-finite numbers (Infinity,
 * NaN) count as present but are excluded from sum/average; an all-empty range
 * yields null sum/average rather than 0.
 */

export interface SelectionStats {
  sum: number | null;
  average: number | null;
  count: number;
  numericCount: number;
}

type ByAddress = Record<string, SheetEvaluationCell>;

const collectCell = (
  cells: { value: number; hasValue: boolean }[],
  byAddress: ByAddress,
  row: number,
  column: number,
): void => {
  const cellData = byAddress[encodeCellAddress(row, column)];
  if (cellData && cellData.type === 'number' && typeof cellData.value === 'number') {
    cells.push({ value: cellData.value, hasValue: true });
  } else if (cellData && cellData.value !== '') {
    cells.push({ value: NaN, hasValue: true });
  }
};

export const computeSelectionStats = (selection: SelectionState, byAddress: ByAddress): SelectionStats => {
  const cells: { value: number; hasValue: boolean }[] = [];

  if (selection.type === 'single') {
    collectCell(cells, byAddress, selection.cell.row, selection.cell.column);
  } else {
    const { start, end } = selection.range;
    const minRow = Math.min(start.row, end.row);
    const maxRow = Math.max(start.row, end.row);
    const minCol = Math.min(start.column, end.column);
    const maxCol = Math.max(start.column, end.column);

    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        collectCell(cells, byAddress, row, col);
      }
    }
  }

  const numericCells = cells.filter((c) => c.hasValue && Number.isFinite(c.value));
  const nonEmptyCells = cells.filter((c) => c.hasValue);

  if (numericCells.length === 0) {
    return { sum: null, average: null, count: nonEmptyCells.length, numericCount: 0 };
  }

  const sum = numericCells.reduce((acc, c) => acc + c.value, 0);
  const average = sum / numericCells.length;

  return {
    sum,
    average,
    count: nonEmptyCells.length,
    numericCount: numericCells.length,
  };
};
