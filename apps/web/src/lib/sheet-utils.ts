/**
 * Utilities for sheet data manipulation and conversion
 */

export interface SheetCell {
  value: string | number | boolean | null;
  formula?: string;
  type?: 'string' | 'number' | 'boolean' | 'date' | 'formula';
  formatting?: {
    bold?: boolean;
    italic?: boolean;
    color?: string;
    backgroundColor?: string;
    numberFormat?: string;
  };
}

export interface SheetData {
  type: 'sheet';
  cells: { [cellRef: string]: SheetCell };
  metadata: {
    rows: number;
    cols: number;
    headers: boolean;
    frozenRows: number;
    lastModified: number;
  };
  dependencies?: { [cellRef: string]: string[] };
  version: number;
}

export interface LegacySheetData {
  type: 'sheet';
  data: string[][];
  metadata: {
    rows: number;
    cols: number;
    headers: boolean;
    frozenRows: number;
  };
  formulas?: { [cellRef: string]: string };
  computedValues?: { [cellRef: string]: string | number };
  version: number;
}

/**
 * Convert A1 notation to row/col coordinates
 * A1 -> {row: 0, col: 0}
 * B5 -> {row: 4, col: 1}
 */
export function parseA1Notation(cellRef: string): { row: number; col: number } {
  const match = cellRef.match(/^([A-Z]+)(\d+)$/);
  if (!match) {
    throw new Error(`Invalid cell reference: ${cellRef}`);
  }

  const colStr = match[1];
  const rowStr = match[2];

  // Convert column letters to number
  let col = 0;
  for (let i = 0; i < colStr.length; i++) {
    col = col * 26 + (colStr.charCodeAt(i) - 64);
  }
  col -= 1; // Convert to 0-based

  const row = parseInt(rowStr, 10) - 1; // Convert to 0-based

  return { row, col };
}

/**
 * Convert row/col coordinates to A1 notation
 * {row: 0, col: 0} -> A1
 * {row: 4, col: 1} -> B5
 */
export function toA1Notation(row: number, col: number): string {
  let columnStr = '';
  let colNum = col + 1; // Convert to 1-based

  while (colNum > 0) {
    colNum -= 1;
    columnStr = String.fromCharCode(65 + (colNum % 26)) + columnStr;
    colNum = Math.floor(colNum / 26);
  }

  return `${columnStr}${row + 1}`;
}

/**
 * Convert legacy sheet data to new format
 */
export function migrateLegacySheetData(legacyData: LegacySheetData): SheetData {
  const cells: { [cellRef: string]: SheetCell } = {};

  // Convert data array to cells object
  for (let row = 0; row < legacyData.data.length; row++) {
    for (let col = 0; col < legacyData.data[row].length; col++) {
      const cellRef = toA1Notation(row, col);
      const value = legacyData.data[row][col];

      if (value !== '' && value !== null && value !== undefined) {
        cells[cellRef] = {
          value,
          type: typeof value === 'number' ? 'number' : 'string'
        };
      }
    }
  }

  // Convert formulas
  if (legacyData.formulas) {
    Object.entries(legacyData.formulas).forEach(([cellRef, formula]) => {
      if (!cells[cellRef]) {
        cells[cellRef] = { value: '' };
      }
      cells[cellRef].formula = formula;
      cells[cellRef].type = 'formula';

      // Use computed value if available
      if (legacyData.computedValues && legacyData.computedValues[cellRef] !== undefined) {
        cells[cellRef].value = legacyData.computedValues[cellRef];
      }
    });
  }

  return {
    type: 'sheet',
    cells,
    metadata: {
      ...legacyData.metadata,
      lastModified: Date.now()
    },
    version: legacyData.version
  };
}

/**
 * Convert new sheet data to RevoGrid format
 */
export function convertToRevoGridData(sheetData: SheetData): {
  source: Record<string, unknown>[];
  columns: Record<string, unknown>[];
} {
  // Determine dimensions
  const cellRefs = Object.keys(sheetData.cells);
  let maxRow = 0;
  let maxCol = 0;

  cellRefs.forEach(cellRef => {
    const { row, col } = parseA1Notation(cellRef);
    maxRow = Math.max(maxRow, row);
    maxCol = Math.max(maxCol, col);
  });

  // Ensure minimum dimensions
  maxRow = Math.max(maxRow, sheetData.metadata.rows - 1, 99);
  maxCol = Math.max(maxCol, sheetData.metadata.cols - 1, 25);

  // Generate columns
  const columns = [];
  for (let col = 0; col <= maxCol; col++) {
    const colKey = toA1Notation(0, col).replace(/\d+/, ''); // Get column letter
    columns.push({
      prop: colKey,
      name: colKey,
      size: 100,
      cellTemplate: 'cell'
    });
  }

  // Generate rows
  const source = [];
  for (let row = 0; row <= maxRow; row++) {
    const rowData: Record<string, unknown> = { _rowIndex: row };

    for (let col = 0; col <= maxCol; col++) {
      const cellRef = toA1Notation(row, col);
      const colKey = toA1Notation(0, col).replace(/\d+/, '');

      const cell = sheetData.cells[cellRef];
      if (cell) {
        rowData[colKey] = cell.value;
        // Store additional cell metadata
        if (cell.formula) {
          rowData[`${colKey}_formula`] = cell.formula;
        }
        if (cell.type) {
          rowData[`${colKey}_type`] = cell.type;
        }
        if (cell.formatting) {
          rowData[`${colKey}_formatting`] = cell.formatting;
        }
      } else {
        rowData[colKey] = '';
      }
    }

    source.push(rowData);
  }

  return { source, columns };
}

/**
 * Convert RevoGrid data back to sheet format
 */
export function convertFromRevoGridData(source: Record<string, unknown>[], columns: Record<string, unknown>[]): { [cellRef: string]: SheetCell } {
  const cells: { [cellRef: string]: SheetCell } = {};

  source.forEach((rowData, rowIndex) => {
    columns.forEach((column, colIndex) => {
      const cellRef = toA1Notation(rowIndex, colIndex);
      const prop = column.prop as string;
      const value = rowData[prop];

      if (value !== '' && value !== null && value !== undefined) {
        const cell: SheetCell = { value: value as string | number | boolean | null };

        // Restore formula if exists
        const formula = rowData[`${prop}_formula`];
        if (formula) {
          cell.formula = formula as string;
          cell.type = 'formula';
        } else {
          cell.type = typeof value === 'number' ? 'number' : 'string';
        }

        // Restore formatting if exists
        const formatting = rowData[`${prop}_formatting`];
        if (formatting) {
          cell.formatting = formatting as Record<string, unknown>;
        }

        cells[cellRef] = cell;
      }
    });
  });

  return cells;
}

/**
 * Extract cell references from a formula
 */
export function extractCellReferences(formula: string): string[] {
  const cellRefPattern = /\b[A-Z]+[0-9]+\b/g;
  const matches = formula.match(cellRefPattern);
  return matches ? [...new Set(matches)] : [];
}

/**
 * Get the range of cells as an array
 */
export function getCellRange(startRef: string, endRef: string): string[] {
  const start = parseA1Notation(startRef);
  const end = parseA1Notation(endRef);

  const minRow = Math.min(start.row, end.row);
  const maxRow = Math.max(start.row, end.row);
  const minCol = Math.min(start.col, end.col);
  const maxCol = Math.max(start.col, end.col);

  const range: string[] = [];

  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      range.push(toA1Notation(row, col));
    }
  }

  return range;
}

/**
 * Check if a string is a valid cell reference
 */
export function isValidCellRef(ref: string): boolean {
  return /^[A-Z]+[0-9]+$/.test(ref);
}

/**
 * Create default sheet data
 */
export function createDefaultSheetData(): SheetData {
  return {
    type: 'sheet',
    cells: {},
    metadata: {
      rows: 100,
      cols: 26,
      headers: false,
      frozenRows: 0,
      lastModified: Date.now()
    },
    version: 2
  };
}