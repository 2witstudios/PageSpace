export interface CellReference {
  type: 'single' | 'range';
  startCell: string;
  endCell?: string;
  cells: string[];
}

export interface ParsedFormula {
  originalFormula: string;
  expression: string;
  functions: string[];
  cellReferences: CellReference[];
  hasFormula: boolean;
}

export class FormulaParser {
  private static readonly FORMULA_REGEX = /^=(.+)$/;
  private static readonly CELL_REF_REGEX = /\b([A-Z]+\d+)(?::([A-Z]+\d+))?\b/g;
  private static readonly FUNCTION_REGEX = /([A-Z]+)\s*\(/g;

  static parse(formula: string): ParsedFormula {
    const formulaMatch = formula.match(this.FORMULA_REGEX);

    if (!formulaMatch) {
      return {
        originalFormula: formula,
        expression: formula,
        functions: [],
        cellReferences: [],
        hasFormula: false
      };
    }

    const expression = formulaMatch[1];
    const functions = this.extractFunctions(expression);
    const cellReferences = this.extractCellReferences(expression);

    return {
      originalFormula: formula,
      expression,
      functions,
      cellReferences,
      hasFormula: true
    };
  }

  static extractFunctions(expression: string): string[] {
    const functions: string[] = [];
    let match;

    // Reset regex lastIndex
    this.FUNCTION_REGEX.lastIndex = 0;

    while ((match = this.FUNCTION_REGEX.exec(expression)) !== null) {
      const functionName = match[1].toUpperCase();
      if (!functions.includes(functionName)) {
        functions.push(functionName);
      }
    }

    return functions;
  }

  static extractCellReferences(expression: string): CellReference[] {
    const references: CellReference[] = [];
    let match;

    // Reset regex lastIndex
    this.CELL_REF_REGEX.lastIndex = 0;

    while ((match = this.CELL_REF_REGEX.exec(expression)) !== null) {
      const startCell = match[1];
      const endCell = match[2];

      if (endCell) {
        // Range reference (e.g., A1:B5)
        const cells = this.expandRange(startCell, endCell);
        references.push({
          type: 'range',
          startCell,
          endCell,
          cells
        });
      } else {
        // Single cell reference (e.g., A1)
        references.push({
          type: 'single',
          startCell,
          cells: [startCell]
        });
      }
    }

    return references;
  }

  static expandRange(startCell: string, endCell: string): string[] {
    const startCoords = this.parseA1Notation(startCell);
    const endCoords = this.parseA1Notation(endCell);

    const cells: string[] = [];

    const minRow = Math.min(startCoords.row, endCoords.row);
    const maxRow = Math.max(startCoords.row, endCoords.row);
    const minCol = Math.min(startCoords.col, endCoords.col);
    const maxCol = Math.max(startCoords.col, endCoords.col);

    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        cells.push(this.toA1Notation(row, col));
      }
    }

    return cells;
  }

  static parseA1Notation(cellRef: string): { row: number; col: number } {
    const match = cellRef.match(/^([A-Z]+)(\d+)$/);
    if (!match) {
      throw new Error(`Invalid cell reference: ${cellRef}`);
    }

    const [, colStr, rowStr] = match;

    // Convert column letters to number (A=0, B=1, ..., Z=25, AA=26, etc.)
    let col = 0;
    for (let i = 0; i < colStr.length; i++) {
      col = col * 26 + (colStr.charCodeAt(i) - 65 + 1);
    }
    col -= 1; // Convert to 0-based index

    const row = parseInt(rowStr, 10) - 1; // Convert to 0-based index

    return { row, col };
  }

  static toA1Notation(row: number, col: number): string {
    let colStr = '';
    let colIndex = col + 1; // Convert to 1-based

    while (colIndex > 0) {
      colIndex -= 1;
      colStr = String.fromCharCode(65 + (colIndex % 26)) + colStr;
      colIndex = Math.floor(colIndex / 26);
    }

    return `${colStr}${row + 1}`;
  }

  static isFormula(value: string): boolean {
    return this.FORMULA_REGEX.test(value);
  }

  static getAllCellReferencesFlat(formula: string): string[] {
    const parsed = this.parse(formula);
    const allCells: string[] = [];

    parsed.cellReferences.forEach(ref => {
      allCells.push(...ref.cells);
    });

    // Remove duplicates
    return [...new Set(allCells)];
  }
}