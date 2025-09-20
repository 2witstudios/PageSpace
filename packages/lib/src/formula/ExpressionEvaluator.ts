import * as FormulaJS from '@formulajs/formulajs';
import { FormulaParser, ParsedFormula } from './FormulaParser';
import { CellReferenceResolver, CellValue } from './CellReferenceResolver';

export interface EvaluationResult {
  value: string | number | null;
  error?: string;
  isFormula: boolean;
}

export class ExpressionEvaluator {
  private resolver: CellReferenceResolver;

  constructor(resolver: CellReferenceResolver) {
    this.resolver = resolver;
  }

  evaluate(formula: string): EvaluationResult {
    try {
      const parsed = FormulaParser.parse(formula);

      if (!parsed.hasFormula) {
        // It's a plain value, not a formula
        return {
          value: this.convertToValue(formula),
          isFormula: false
        };
      }

      const result = this.evaluateExpression(parsed);

      return {
        value: result,
        isFormula: true
      };
    } catch (error) {
      return {
        value: null,
        error: error instanceof Error ? error.message : 'Unknown error',
        isFormula: FormulaParser.isFormula(formula)
      };
    }
  }

  private evaluateExpression(parsed: ParsedFormula): string | number {
    let expression = parsed.expression;

    // First, handle Formula.js functions
    if (parsed.functions.length > 0) {
      expression = this.evaluateFormulajsFunctions(expression, parsed);
    }

    // Then handle cell references and basic arithmetic
    expression = this.replaceCellReferences(expression, parsed);

    // Finally, evaluate arithmetic expressions
    return this.evaluateArithmetic(expression);
  }

  private evaluateFormulajsFunctions(expression: string, parsed: ParsedFormula): string {
    let result = expression;

    // Handle each function one by one
    parsed.functions.forEach(funcName => {
      const pattern = new RegExp(`\\b${funcName}\\s*\\(([^)]+)\\)`, 'gi');

      result = result.replace(pattern, (match, argsString) => {
        try {
          return this.callFormulaFunction(funcName, argsString, parsed);
        } catch (error) {
          throw new Error(`Error in ${funcName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      });
    });

    return result;
  }

  private callFormulaFunction(funcName: string, argsString: string, parsed: ParsedFormula): string {
    const func = (FormulaJS as any)[funcName];
    if (!func || typeof func !== 'function') {
      throw new Error(`Unknown function: ${funcName}`);
    }

    // Parse and resolve arguments
    const args = this.parseAndResolveArguments(argsString, parsed);
    const result = func(...args);

    return String(result);
  }

  private parseAndResolveArguments(argsString: string, parsed: ParsedFormula): any[] {
    const args: any[] = [];

    // Simple argument parsing (comma-separated)
    const argStrings = this.splitArguments(argsString);

    argStrings.forEach(argString => {
      const trimmedArg = argString.trim();

      // Check if it's a range (A1:B5)
      if (trimmedArg.includes(':')) {
        const rangeParts = trimmedArg.split(':');
        if (rangeParts.length === 2) {
          const startCell = rangeParts[0].trim();
          const endCell = rangeParts[1].trim();

          if (this.isValidCellRef(startCell) && this.isValidCellRef(endCell)) {
            const cellValues = this.resolver.resolveRangeToValues(startCell, endCell);
            const numericValues = this.resolver.convertToNumericValues(cellValues);
            args.push(numericValues);
            return;
          }
        }
      }

      // Check if it's a single cell reference
      if (this.isValidCellRef(trimmedArg)) {
        const cellValue = this.resolver.resolveCellReference(trimmedArg);
        const numericValue = this.resolver.convertToNumericValues([cellValue])[0];
        args.push(numericValue);
        return;
      }

      // Parse as literal value
      args.push(this.parseLiteralValue(trimmedArg));
    });

    return args;
  }

  private splitArguments(argsString: string): string[] {
    const args: string[] = [];
    let current = '';
    let depth = 0;
    let inQuotes = false;

    for (let i = 0; i < argsString.length; i++) {
      const char = argsString[i];

      if (char === '"' && (i === 0 || argsString[i - 1] !== '\\')) {
        inQuotes = !inQuotes;
        current += char;
      } else if (!inQuotes) {
        if (char === '(' || char === '[') {
          depth++;
          current += char;
        } else if (char === ')' || char === ']') {
          depth--;
          current += char;
        } else if (char === ',' && depth === 0) {
          args.push(current);
          current = '';
        } else {
          current += char;
        }
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      args.push(current);
    }

    return args;
  }

  private replaceCellReferences(expression: string, parsed: ParsedFormula): string {
    let result = expression;

    // Replace single cell references
    parsed.cellReferences.forEach(ref => {
      if (ref.type === 'single') {
        const cellValue = this.resolver.resolveCellReference(ref.startCell);
        const numericValue = this.resolver.convertToNumericValues([cellValue])[0];

        // Use word boundaries to avoid partial replacements
        const pattern = new RegExp(`\\b${this.escapeRegex(ref.startCell)}\\b`, 'g');
        result = result.replace(pattern, String(numericValue));
      }
    });

    return result;
  }

  private evaluateArithmetic(expression: string): string | number {
    // Handle simple cases first
    if (this.isNumeric(expression)) {
      return parseFloat(expression);
    }

    // For basic arithmetic expressions, use safe evaluation
    try {
      // Only allow safe arithmetic operations
      const cleanExpression = expression.replace(/[^0-9+\-*/.() ]/g, '');

      if (/^[0-9+\-*/.() ]+$/.test(cleanExpression) && cleanExpression.trim()) {
        // Use Function constructor for safe evaluation of arithmetic
        const result = new Function(`"use strict"; return (${cleanExpression})`)();

        if (typeof result === 'number' && !isNaN(result)) {
          return result;
        }
      }

      // If we can't evaluate it safely, return the original expression
      return expression;
    } catch {
      // If evaluation fails, return the expression as-is
      return expression;
    }
  }

  private parseLiteralValue(value: string): any {
    const trimmed = value.trim();

    // Handle quoted strings
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1);
    }

    // Handle numbers
    const numValue = parseFloat(trimmed);
    if (!isNaN(numValue)) {
      return numValue;
    }

    // Handle booleans
    if (trimmed.toLowerCase() === 'true') return true;
    if (trimmed.toLowerCase() === 'false') return false;

    // Return as string
    return trimmed;
  }

  private convertToValue(value: string): string | number {
    if (this.isNumeric(value)) {
      return parseFloat(value);
    }
    return value;
  }

  private isNumeric(value: string): boolean {
    // Check if the entire string is a single number
    return /^-?\d+\.?\d*$/.test(value.trim());
  }

  private isValidCellRef(value: string): boolean {
    return /^[A-Z]+\d+$/.test(value.trim());
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  getAvailableFunctions(): string[] {
    return Object.keys(FormulaJS).filter(key =>
      typeof (FormulaJS as any)[key] === 'function'
    );
  }

  validateFunction(functionName: string): boolean {
    return typeof (FormulaJS as any)[functionName] === 'function';
  }
}