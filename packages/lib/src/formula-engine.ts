import { FormulaParser } from './formula/FormulaParser';
import { DependencyTracker } from './formula/DependencyTracker';
import { CellReferenceResolver, CellValue, SheetDataProvider } from './formula/CellReferenceResolver';
import { ExpressionEvaluator } from './formula/ExpressionEvaluator';

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

class SheetDataProviderImpl implements SheetDataProvider {
  constructor(private engine: FormulaEngine) {}

  getCellValue(cellRef: string): CellValue {
    const value = this.engine.getRawCellValue(cellRef);

    if (value === null || value === undefined) {
      return { value: '', isError: false };
    }

    if (typeof value === 'string' && value.startsWith('#')) {
      return { value: '', isError: true, errorMessage: value };
    }

    return { value, isError: false };
  }

  getCellValues(cellRefs: string[]): CellValue[] {
    return cellRefs.map(ref => this.getCellValue(ref));
  }
}

export class FormulaEngine {
  private cellValues: Map<string, string | number> = new Map();
  private cellFormulas: Map<string, string> = new Map();
  private dependencyTracker: DependencyTracker = new DependencyTracker();
  private dataProvider: SheetDataProviderImpl;
  private resolver: CellReferenceResolver;
  private evaluator: ExpressionEvaluator;

  constructor() {
    this.dataProvider = new SheetDataProviderImpl(this);
    this.resolver = new CellReferenceResolver(this.dataProvider);
    this.evaluator = new ExpressionEvaluator(this.resolver);
  }

  /**
   * Convert A1 notation to row/col coordinates
   * A1 -> {row: 0, col: 0}
   * B5 -> {row: 4, col: 1}
   */
  parseA1Notation(cellRef: string): CellReference {
    const coords = FormulaParser.parseA1Notation(cellRef);
    return { row: coords.row, col: coords.col };
  }

  /**
   * Convert row/col coordinates to A1 notation
   * {row: 0, col: 0} -> A1
   * {row: 4, col: 1} -> B5
   */
  toA1Notation(row: number, col: number): string {
    return FormulaParser.toA1Notation(row, col);
  }

  /**
   * Set a cell value or formula
   */
  setCellContent(cellRef: string, content: string | number): FormulaResult {
    try {
      const isFormula = typeof content === 'string' && content.startsWith('=');

      if (isFormula) {
        return this.setFormula(cellRef, content);
      } else {
        return this.setValue(cellRef, content);
      }
    } catch (error) {
      return {
        value: null,
        error: error instanceof Error ? error.message : 'Unknown error',
        isFormula: typeof content === 'string' && content.startsWith('='),
      };
    }
  }

  private setFormula(cellRef: string, formula: string): FormulaResult {
    try {
      // Parse formula to extract dependencies
      const allCellRefs = FormulaParser.getAllCellReferencesFlat(formula);

      // Update dependency tracking
      this.dependencyTracker.updateDependencies(cellRef, allCellRefs);

      // Check for circular references
      if (this.dependencyTracker.detectCircularReference(cellRef)) {
        throw new Error('Circular reference detected');
      }

      // Store formula
      this.cellFormulas.set(cellRef, formula);

      // Calculate value
      const result = this.evaluator.evaluate(formula);

      if (result.error) {
        this.cellValues.set(cellRef, `#ERROR: ${result.error}`);
        return {
          value: `#ERROR: ${result.error}`,
          error: result.error,
          isFormula: true
        };
      } else {
        this.cellValues.set(cellRef, result.value || '');

        // Trigger recalculation of dependents
        this.recalculateDependents(cellRef);

        return {
          value: this.formatValue(result.value),
          isFormula: true
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.cellValues.set(cellRef, `#ERROR: ${errorMessage}`);
      return {
        value: `#ERROR: ${errorMessage}`,
        error: errorMessage,
        isFormula: true,
      };
    }
  }

  private setValue(cellRef: string, value: string | number): FormulaResult {
    // Remove any existing formula and its precedents, but keep this cell as a precedent for others
    this.cellFormulas.delete(cellRef);
    this.dependencyTracker.removePrecedents(cellRef);

    // Store the value
    this.cellValues.set(cellRef, value);

    // Trigger recalculation of dependents
    this.recalculateDependents(cellRef);

    return {
      value: this.formatValue(value),
      isFormula: false
    };
  }

  private recalculateDependents(cellRef: string): void {
    try {
      const dependents = this.dependencyTracker.getAllDependents(cellRef);
      const calculationOrder = this.dependencyTracker.getCalculationOrder(dependents);

      calculationOrder.forEach(dependentRef => {
        const formula = this.cellFormulas.get(dependentRef);

        if (formula) {
          // Recalculate this dependent cell
          const result = this.evaluator.evaluate(formula);

          if (result.error) {
            this.cellValues.set(dependentRef, `#ERROR: ${result.error}`);
          } else {
            this.cellValues.set(dependentRef, result.value || '');
          }
        }
      });
    } catch (error) {
      console.error('Error during recalculation:', error);
    }
  }

  /**
   * Get the value of a cell
   */
  getCellValue(cellRef: string): FormulaResult {
    try {
      const value = this.cellValues.get(cellRef);
      const formula = this.cellFormulas.get(cellRef);
      const isFormula = formula !== undefined;

      return {
        value: value !== undefined ? this.formatValue(value) : '',
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
   * Get the raw cell value (used internally by the data provider)
   */
  getRawCellValue(cellRef: string): string | number | null {
    return this.cellValues.get(cellRef) || null;
  }

  /**
   * Get the raw formula of a cell (if it has one)
   */
  getCellFormula(cellRef: string): string | undefined {
    return this.cellFormulas.get(cellRef);
  }

  /**
   * Check if a cell contains a formula
   */
  isFormula(cellRef: string): boolean {
    return this.cellFormulas.has(cellRef);
  }

  /**
   * Get all cells that depend on the given cell
   */
  getDependents(cellRef: string): string[] {
    return this.dependencyTracker.getDependents(cellRef);
  }

  /**
   * Get all cells that the given cell depends on
   */
  getPrecedents(cellRef: string): string[] {
    return this.dependencyTracker.getPrecedents(cellRef);
  }

  /**
   * Recalculate all formulas
   */
  recalculate(): void {
    try {
      const allFormulaCells = Array.from(this.cellFormulas.keys());
      const calculationOrder = this.dependencyTracker.getCalculationOrder(allFormulaCells);

      calculationOrder.forEach(cellRef => {
        const formula = this.cellFormulas.get(cellRef);
        if (formula) {
          const result = this.evaluator.evaluate(formula);

          if (result.error) {
            this.cellValues.set(cellRef, `#ERROR: ${result.error}`);
          } else {
            this.cellValues.set(cellRef, result.value || '');
          }
        }
      });
    } catch (error) {
      console.error('Error during recalculation:', error);
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.cellValues.clear();
    this.cellFormulas.clear();
    this.dependencyTracker.clear();
  }

  /**
   * Get the current sheet data as a 2D array
   */
  getSheetData(): (string | number)[][] {
    const data: (string | number)[][] = [];

    // Find the maximum row and column
    let maxRow = 0;
    let maxCol = 0;

    this.cellValues.forEach((_, cellRef) => {
      const coords = this.parseA1Notation(cellRef);
      maxRow = Math.max(maxRow, coords.row);
      maxCol = Math.max(maxCol, coords.col);
    });

    // Create the data array
    for (let row = 0; row <= maxRow; row++) {
      const rowData: (string | number)[] = [];
      for (let col = 0; col <= maxCol; col++) {
        const cellRef = this.toA1Notation(row, col);
        const value = this.cellValues.get(cellRef);
        rowData.push(this.formatValue(value || ''));
      }
      data.push(rowData);
    }

    return data;
  }

  /**
   * Load data from a 2D array
   */
  loadData(data: (string | number)[][]): void {
    this.clear();

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

    // Handle error values that start with #
    if (typeof value === 'string' && value.startsWith('#')) {
      return value;
    }

    return value;
  }

  /**
   * Get available function names
   */
  getAvailableFunctions(): string[] {
    return this.evaluator.getAvailableFunctions();
  }

  /**
   * Destroy the engine instance
   */
  destroy(): void {
    this.clear();
  }
}

// Export a default instance for simple usage
export const formulaEngine = new FormulaEngine();