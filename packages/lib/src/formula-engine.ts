import { HyperFormula, ConfigParams } from 'hyperformula';

export interface CellReference {
  row: number;
  col: number;
}

export interface FormulaResult {
  value: string | number | null;
  error?: string;
  isFormula: boolean;
}

export interface CellAddress {
  sheet: number;
  row: number;
  col: number;
}

export class FormulaEngine {
  private hf: HyperFormula;
  private sheetId: number = 0;

  constructor(config?: Partial<ConfigParams>) {
    const defaultConfig: Partial<ConfigParams> = {
      licenseKey: 'gpl-v3',
      useColumnIndex: true,
      // Performance optimizations
      smartRounding: true,
      nullYear: 30,
      leapYear1900: false,
      // Function configurations
      functionArgSeparator: ',',
      arrayColumnSeparator: ',',
      arrayRowSeparator: ';',
      ...config
    };

    this.hf = HyperFormula.buildEmpty(defaultConfig);
    // Use the default sheet that's already created
    this.sheetId = 0;
  }

  /**
   * Convert A1 notation to row/col coordinates
   * A1 -> {row: 0, col: 0}
   * B5 -> {row: 4, col: 1}
   */
  parseA1Notation(cellRef: string): CellReference {
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

  /**
   * Convert row/col coordinates to A1 notation
   * {row: 0, col: 0} -> A1
   * {row: 4, col: 1} -> B5
   */
  toA1Notation(row: number, col: number): string {
    let colStr = '';
    let colIndex = col + 1; // Convert to 1-based

    while (colIndex > 0) {
      colIndex -= 1;
      colStr = String.fromCharCode(65 + (colIndex % 26)) + colStr;
      colIndex = Math.floor(colIndex / 26);
    }

    return `${colStr}${row + 1}`;
  }

  /**
   * Set a cell value or formula
   */
  setCellContent(cellRef: string, content: string | number): FormulaResult {
    try {
      const { row, col } = this.parseA1Notation(cellRef);
      const address: CellAddress = { sheet: this.sheetId, row, col };

      // Set the content in HyperFormula
      this.hf.setCellContents(address, [[content]]);

      // Get the computed value
      const value = this.hf.getCellValue(address);
      const isFormula = typeof content === 'string' && content.startsWith('=');

      return {
        value: this.formatValue(value),
        isFormula,
      };
    } catch (error) {
      return {
        value: null,
        error: error instanceof Error ? error.message : 'Unknown error',
        isFormula: typeof content === 'string' && content.startsWith('='),
      };
    }
  }

  /**
   * Get the value of a cell
   */
  getCellValue(cellRef: string): FormulaResult {
    try {
      const { row, col } = this.parseA1Notation(cellRef);
      const address: CellAddress = { sheet: this.sheetId, row, col };

      const value = this.hf.getCellValue(address);
      const formula = this.hf.getCellFormula(address);
      const isFormula = formula !== undefined;

      return {
        value: this.formatValue(value),
        isFormula,
      };
    } catch (error) {
      return {
        value: null,
        error: error instanceof Error ? error.message : 'Unknown error',
        isFormula: false,
      };
    }
  }

  /**
   * Get the raw formula of a cell (if it has one)
   */
  getCellFormula(cellRef: string): string | undefined {
    try {
      const { row, col } = this.parseA1Notation(cellRef);
      const address: CellAddress = { sheet: this.sheetId, row, col };
      return this.hf.getCellFormula(address);
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Check if a cell contains a formula
   */
  isFormula(cellRef: string): boolean {
    return this.getCellFormula(cellRef) !== undefined;
  }

  /**
   * Get all cells that depend on the given cell
   */
  getDependents(cellRef: string): string[] {
    try {
      const { row, col } = this.parseA1Notation(cellRef);
      const address: CellAddress = { sheet: this.sheetId, row, col };

      const dependents = this.hf.getCellDependents(address);
      return dependents
        .filter(dep => 'row' in dep && 'col' in dep)
        .map(dep => this.toA1Notation(dep.row, dep.col));
    } catch (error) {
      return [];
    }
  }

  /**
   * Get all cells that the given cell depends on
   */
  getPrecedents(cellRef: string): string[] {
    try {
      const { row, col } = this.parseA1Notation(cellRef);
      const address: CellAddress = { sheet: this.sheetId, row, col };

      const precedents = this.hf.getCellPrecedents(address);
      return precedents
        .filter(prec => 'row' in prec && 'col' in prec)
        .map(prec => this.toA1Notation(prec.row, prec.col));
    } catch (error) {
      return [];
    }
  }

  /**
   * Recalculate all formulas
   */
  recalculate(): void {
    // HyperFormula automatically recalculates when dependencies change
    // This method is here for explicit recalculation if needed
    this.hf.rebuildAndRecalculate();
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.hf.clearSheet(this.sheetId);
  }

  /**
   * Get the current sheet data as a 2D array
   */
  getSheetData(): (string | number)[][] {
    const sheetSize = this.hf.getSheetDimensions(this.sheetId);
    const data: (string | number)[][] = [];

    for (let row = 0; row < sheetSize.height; row++) {
      const rowData: (string | number)[] = [];
      for (let col = 0; col < sheetSize.width; col++) {
        const address: CellAddress = { sheet: this.sheetId, row, col };
        const value = this.hf.getCellValue(address);
        rowData.push(this.formatValue(value));
      }
      data.push(rowData);
    }

    return data;
  }

  /**
   * Load data from a 2D array
   */
  loadData(data: (string | number)[][]): void {
    if (data.length === 0) return;

    // Clear existing data
    this.clear();

    // Set all cell contents
    for (let row = 0; row < data.length; row++) {
      for (let col = 0; col < data[row].length; col++) {
        const value = data[row][col];
        if (value !== '' && value !== null && value !== undefined) {
          const cellRef = this.toA1Notation(row, col);
          this.setCellContent(cellRef, value);
        }
      }
    }
  }

  /**
   * Format a value for display
   */
  private formatValue(value: any): string | number {
    if (value === null || value === undefined) {
      return '';
    }

    // Handle HyperFormula error values
    if (typeof value === 'object' && value.type === 'DIV_BY_ZERO') {
      return '#DIV/0!';
    }
    if (typeof value === 'object' && value.type === 'NA') {
      return '#N/A';
    }
    if (typeof value === 'object' && value.type === 'NAME') {
      return '#NAME?';
    }
    if (typeof value === 'object' && value.type === 'NULL') {
      return '#NULL!';
    }
    if (typeof value === 'object' && value.type === 'NUM') {
      return '#NUM!';
    }
    if (typeof value === 'object' && value.type === 'REF') {
      return '#REF!';
    }
    if (typeof value === 'object' && value.type === 'VALUE') {
      return '#VALUE!';
    }

    // Handle other error objects
    if (typeof value === 'object' && 'type' in value) {
      return `#ERROR!`;
    }

    return value;
  }

  /**
   * Get available function names
   */
  getAvailableFunctions(): string[] {
    // Note: This method may not be available in all HyperFormula versions
    return ['SUM', 'AVERAGE', 'COUNT', 'MIN', 'MAX', 'IF']; // Basic list
  }

  /**
   * Destroy the engine instance
   */
  destroy(): void {
    this.hf.destroy();
  }
}

// Export a default instance for simple usage
export const formulaEngine = new FormulaEngine();