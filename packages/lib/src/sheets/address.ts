/**
 * @module @pagespace/lib/sheets/address
 * @description Cell address encoding, decoding, and manipulation utilities
 */

import type { SheetCellAddress } from './types';

// Regex patterns for cell address validation
export const cellRegex = /^[A-Z]+\d+$/;
export const numberRegex = /^-?(?:\d+\.?\d*|\.\d+)$/;
export const externalReferenceRegex =
  /^@\[(?<label>[^\]]+)\](?:\((?<identifier>[^):]+)(?::(?<mentionType>[^)]+))?\))?:(?<address>[A-Z]+\d+)$/i;

/**
 * Encode row and column indices to A1-style cell address
 */
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

/**
 * Decode A1-style cell address to row and column indices
 */
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

/**
 * Validate a cell address is in valid A1 format
 */
export function isValidCellAddress(address: string): boolean {
  const normalized = address.trim().toUpperCase();
  return cellRegex.test(normalized);
}

/**
 * Expand a range of cell addresses (e.g., A1:B2 -> [A1, A2, B1, B2])
 */
export function expandRange(start: string, end: string): SheetCellAddress[] {
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

/**
 * Adjust formula references when copying cells
 */
export function adjustFormulaReferences(
  formula: string,
  rowOffset: number,
  colOffset: number
): string {
  if (!formula.startsWith('=')) {
    return formula;
  }

  let result = '';
  let index = 0;

  while (index < formula.length) {
    const start = index;
    let colDollar = '';
    let rowDollar = '';

    if (formula.charCodeAt(index) === 36) {
      colDollar = '$';
      index += 1;
    }

    const colStart = index;
    while (index < formula.length && isUpperAsciiLetter(formula.charCodeAt(index))) {
      index += 1;
    }
    const colEnd = index;

    if (colStart === colEnd) {
      result += formula[start];
      index = start + 1;
      continue;
    }

    if (formula.charCodeAt(index) === 36) {
      rowDollar = '$';
      index += 1;
    }

    const rowStart = index;
    while (index < formula.length && isAsciiDigit(formula.charCodeAt(index))) {
      index += 1;
    }
    const rowEnd = index;

    if (rowStart === rowEnd) {
      const consumedEnd = rowDollar === '$' ? rowStart : colEnd;
      result += formula.slice(start, consumedEnd);
      index = consumedEnd;
      continue;
    }

    const colLetters = formula.slice(colStart, colEnd);
    const rowNum = formula.slice(rowStart, rowEnd);
    const originalToken = formula.slice(start, rowEnd);

    try {
      const originalRef = `${colLetters}${rowNum}`;
      const { row: origRow, column: origCol } = decodeCellAddress(originalRef);

      const newRow = rowDollar === '$' ? origRow : Math.max(0, origRow + rowOffset);
      const newCol = colDollar === '$' ? origCol : Math.max(0, origCol + colOffset);

      const adjusted = encodeCellAddress(newRow, newCol);
      const { columnLetters, rowNumber } = splitEncodedCellAddress(adjusted);
      result += `${colDollar}${columnLetters}${rowDollar}${rowNumber}`;
    } catch {
      result += originalToken;
    }
  }

  return result;
}

// Internal helper functions
function isUpperAsciiLetter(charCode: number): boolean {
  return charCode >= 65 && charCode <= 90;
}

function isAsciiDigit(charCode: number): boolean {
  return charCode >= 48 && charCode <= 57;
}

function splitEncodedCellAddress(address: string): {
  columnLetters: string;
  rowNumber: string;
} {
  let index = 0;
  while (index < address.length && isUpperAsciiLetter(address.charCodeAt(index))) {
    index += 1;
  }

  return {
    columnLetters: address.slice(0, index),
    rowNumber: address.slice(index),
  };
}
