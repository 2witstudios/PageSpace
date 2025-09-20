import { FormulaParser } from './FormulaParser';

export interface CellValue {
  value: string | number;
  isError: boolean;
  errorMessage?: string;
}

export interface SheetDataProvider {
  getCellValue(cellRef: string): CellValue;
  getCellValues(cellRefs: string[]): CellValue[];
}

export class CellReferenceResolver {
  constructor(private dataProvider: SheetDataProvider) {}

  resolveCellReference(cellRef: string): CellValue {
    return this.dataProvider.getCellValue(cellRef);
  }

  resolveCellReferences(cellRefs: string[]): CellValue[] {
    return this.dataProvider.getCellValues(cellRefs);
  }

  resolveRangeToValues(startCell: string, endCell: string): CellValue[] {
    const cells = FormulaParser.expandRange(startCell, endCell);
    return this.resolveCellReferences(cells);
  }

  resolveFormulaReferences(formula: string): { [cellRef: string]: CellValue } {
    const parsed = FormulaParser.parse(formula);
    const resolved: { [cellRef: string]: CellValue } = {};

    parsed.cellReferences.forEach(ref => {
      ref.cells.forEach(cellRef => {
        if (!resolved[cellRef]) {
          resolved[cellRef] = this.resolveCellReference(cellRef);
        }
      });
    });

    return resolved;
  }

  convertToNumericValues(cellValues: CellValue[]): number[] {
    return cellValues.map(cellValue => {
      if (cellValue.isError) {
        return 0; // or NaN, depending on desired behavior
      }

      const value = cellValue.value;

      if (typeof value === 'number') {
        return value;
      }

      if (typeof value === 'string') {
        // Try to parse as number
        const parsed = parseFloat(value);
        if (!isNaN(parsed)) {
          return parsed;
        }

        // Handle special cases
        if (value.toLowerCase() === 'true') return 1;
        if (value.toLowerCase() === 'false') return 0;
        if (value === '') return 0;

        return 0; // Default for unparseable strings
      }

      return 0;
    });
  }

  convertToStringValues(cellValues: CellValue[]): string[] {
    return cellValues.map(cellValue => {
      if (cellValue.isError) {
        return cellValue.errorMessage || '#ERROR!';
      }

      if (cellValue.value === null || cellValue.value === undefined) {
        return '';
      }

      return String(cellValue.value);
    });
  }

  filterNumericValues(cellValues: CellValue[]): number[] {
    return cellValues
      .filter(cellValue => !cellValue.isError)
      .map(cellValue => {
        const value = cellValue.value;

        if (typeof value === 'number') {
          return value;
        }

        if (typeof value === 'string') {
          const parsed = parseFloat(value);
          if (!isNaN(parsed)) {
            return parsed;
          }
        }

        return null;
      })
      .filter((value): value is number => value !== null);
  }

  countNonEmptyValues(cellValues: CellValue[]): number {
    return cellValues.filter(cellValue => {
      if (cellValue.isError) return false;
      const value = cellValue.value;
      return value !== null && value !== undefined && value !== '';
    }).length;
  }

  countNumericValues(cellValues: CellValue[]): number {
    return cellValues.filter(cellValue => {
      if (cellValue.isError) return false;
      const value = cellValue.value;

      if (typeof value === 'number') {
        return !isNaN(value);
      }

      if (typeof value === 'string') {
        const parsed = parseFloat(value);
        return !isNaN(parsed);
      }

      return false;
    }).length;
  }

  hasErrors(cellValues: CellValue[]): boolean {
    return cellValues.some(cellValue => cellValue.isError);
  }

  getFirstError(cellValues: CellValue[]): string | null {
    const errorCell = cellValues.find(cellValue => cellValue.isError);
    return errorCell ? (errorCell.errorMessage || '#ERROR!') : null;
  }

  validateCellReference(cellRef: string): boolean {
    try {
      FormulaParser.parseA1Notation(cellRef);
      return true;
    } catch {
      return false;
    }
  }

  validateRange(startCell: string, endCell: string): boolean {
    try {
      const startCoords = FormulaParser.parseA1Notation(startCell);
      const endCoords = FormulaParser.parseA1Notation(endCell);

      // Ensure start is before end
      return startCoords.row <= endCoords.row && startCoords.col <= endCoords.col;
    } catch {
      return false;
    }
  }

  getRangeSize(startCell: string, endCell: string): { rows: number; cols: number } {
    const startCoords = FormulaParser.parseA1Notation(startCell);
    const endCoords = FormulaParser.parseA1Notation(endCell);

    return {
      rows: Math.abs(endCoords.row - startCoords.row) + 1,
      cols: Math.abs(endCoords.col - startCoords.col) + 1
    };
  }

  isValidCellReference(cellRef: string): boolean {
    return /^[A-Z]+\d+$/.test(cellRef);
  }

  isValidRange(range: string): boolean {
    const rangeMatch = range.match(/^([A-Z]+\d+):([A-Z]+\d+)$/);
    if (!rangeMatch) {
      return false;
    }

    const [, startCell, endCell] = rangeMatch;
    return this.validateRange(startCell, endCell);
  }
}