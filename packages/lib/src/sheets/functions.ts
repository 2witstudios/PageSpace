/**
 * @module @pagespace/lib/sheets/functions
 * @description Spreadsheet function implementations
 */

import type { ASTNode, EvalValue, SheetPrimitive } from './types';

/**
 * Coerce a value to a number
 */
export function coerceNumber(value: SheetPrimitive): number {
  if (value === '') {
    return 0;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }
  const parsed = Number(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error('Expected a numeric value');
  }
  return parsed;
}

/**
 * Convert a value to boolean
 */
export function toBoolean(value: SheetPrimitive): boolean {
  if (value === '') {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toUpperCase();
  if (normalized === 'TRUE') {
    return true;
  }
  if (normalized === 'FALSE') {
    return false;
  }
  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric)) {
    return numeric !== 0;
  }
  return true;
}

/**
 * Flatten nested values to a single array
 */
export function flattenValue(value: EvalValue): SheetPrimitive[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenValue(item));
  }
  return [value];
}

/**
 * Format a value for display
 */
export function formatDisplayValue(value: SheetPrimitive): string {
  if (value === '') {
    return '';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return '#ERROR';
    }
    const stringValue = value.toString();
    return stringValue.length > 12 ? value.toPrecision(12).replace(/0+$/g, '').replace(/\.$/, '') : stringValue;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return value;
}

/**
 * Evaluate a function call
 */
export function evaluateFunction(
  name: string,
  args: ASTNode[],
  evaluateNode: (node: ASTNode) => EvalValue
): SheetPrimitive {
  const upperName = name.toUpperCase();

  // Handle functions that need lazy evaluation first (before evaluating all args)
  switch (upperName) {
    case 'IFERROR': {
      if (args.length < 2) {
        throw new Error('IFERROR expects at least two arguments');
      }
      try {
        return flattenValue(evaluateNode(args[0]))[0];
      } catch {
        return flattenValue(evaluateNode(args[1]))[0];
      }
    }
  }

  // For all other functions, evaluate args upfront
  const values = args.flatMap((arg) => flattenValue(evaluateNode(arg)));

  switch (upperName) {
    case 'SUM': {
      return values.reduce<number>((total, value) => total + coerceNumber(value), 0);
    }
    case 'AVERAGE':
    case 'AVG': {
      const numericValues = values.filter((value) => {
        if (value === '' || (typeof value === 'string' && value.trim() === '')) {
          return false;
        }
        try {
          coerceNumber(value);
          return true;
        } catch {
          return false;
        }
      });
      if (numericValues.length === 0) {
        return 0;
      }
      const sum = numericValues.reduce<number>((total, value) => total + coerceNumber(value), 0);
      return sum / numericValues.length;
    }
    case 'MIN': {
      const numericValues = values.map((value) => coerceNumber(value));
      return numericValues.length ? Math.min(...numericValues) : 0;
    }
    case 'MAX': {
      const numericValues = values.map((value) => coerceNumber(value));
      return numericValues.length ? Math.max(...numericValues) : 0;
    }
    case 'COUNT': {
      return values.reduce<number>((count, value) => {
        if (value === '' || value === null || value === undefined) {
          return count;
        }
        if (typeof value === 'number') {
          return count + 1;
        }
        if (typeof value === 'boolean') {
          return count + 1;
        }
        const numeric = Number(value);
        return Number.isNaN(numeric) ? count : count + 1;
      }, 0);
    }
    case 'COUNTA': {
      return values.reduce<number>((count, value) => (value === '' ? count : count + 1), 0);
    }
    case 'ABS': {
      if (values.length !== 1) {
        throw new Error('ABS expects exactly one argument');
      }
      return Math.abs(coerceNumber(values[0]));
    }
    case 'ROUND': {
      if (values.length === 0) {
        throw new Error('ROUND expects at least one argument');
      }
      const value = coerceNumber(values[0]);
      const precision = values.length > 1 ? coerceNumber(values[1]) : 0;
      const factor = Math.pow(10, precision);
      return Math.round(value * factor) / factor;
    }
    case 'FLOOR': {
      if (values.length === 0) {
        throw new Error('FLOOR expects at least one argument');
      }
      const value = coerceNumber(values[0]);
      const significance = values.length > 1 ? Math.abs(coerceNumber(values[1])) : 1;
      if (significance === 0) {
        throw new Error('FLOOR significance cannot be zero');
      }
      return Math.floor(value / significance) * significance;
    }
    case 'CEILING': {
      if (values.length === 0) {
        throw new Error('CEILING expects at least one argument');
      }
      const value = coerceNumber(values[0]);
      const significance = values.length > 1 ? Math.abs(coerceNumber(values[1])) : 1;
      if (significance === 0) {
        throw new Error('CEILING significance cannot be zero');
      }
      return Math.ceil(value / significance) * significance;
    }
    case 'IF': {
      if (args.length < 2) {
        throw new Error('IF expects at least two arguments');
      }
      const conditionValue = flattenValue(evaluateNode(args[0]))[0];
      const condition = toBoolean(conditionValue);
      if (condition) {
        return flattenValue(evaluateNode(args[1]))[0];
      }
      if (args.length >= 3) {
        return flattenValue(evaluateNode(args[2]))[0];
      }
      return '';
    }
    case 'CONCAT':
    case 'CONCATENATE': {
      return values.map((value) => String(value)).join('');
    }
    // String functions
    case 'UPPER': {
      if (values.length !== 1) {
        throw new Error('UPPER expects exactly one argument');
      }
      return String(values[0]).toUpperCase();
    }
    case 'LOWER': {
      if (values.length !== 1) {
        throw new Error('LOWER expects exactly one argument');
      }
      return String(values[0]).toLowerCase();
    }
    case 'TRIM': {
      if (values.length !== 1) {
        throw new Error('TRIM expects exactly one argument');
      }
      return String(values[0]).trim();
    }
    case 'LEN': {
      if (values.length !== 1) {
        throw new Error('LEN expects exactly one argument');
      }
      return String(values[0]).length;
    }
    case 'LEFT': {
      if (values.length < 1 || values.length > 2) {
        throw new Error('LEFT expects one or two arguments');
      }
      const text = String(values[0]);
      const numChars = values.length > 1 ? coerceNumber(values[1]) : 1;
      return text.substring(0, Math.max(0, Math.floor(numChars)));
    }
    case 'RIGHT': {
      if (values.length < 1 || values.length > 2) {
        throw new Error('RIGHT expects one or two arguments');
      }
      const text = String(values[0]);
      const numChars = values.length > 1 ? coerceNumber(values[1]) : 1;
      const chars = Math.max(0, Math.floor(numChars));
      return chars > 0 ? text.slice(-chars) : '';
    }
    case 'MID': {
      if (values.length !== 3) {
        throw new Error('MID expects exactly three arguments');
      }
      const text = String(values[0]);
      const startNum = Math.max(1, Math.floor(coerceNumber(values[1])));
      const numChars = Math.max(0, Math.floor(coerceNumber(values[2])));
      return text.substring(startNum - 1, startNum - 1 + numChars);
    }
    case 'SUBSTITUTE': {
      if (values.length < 3 || values.length > 4) {
        throw new Error('SUBSTITUTE expects three or four arguments');
      }
      const text = String(values[0]);
      const oldText = String(values[1]);
      const newText = String(values[2]);
      if (values.length === 4) {
        const instanceNum = Math.floor(coerceNumber(values[3]));
        if (instanceNum < 1) {
          throw new Error('SUBSTITUTE instance_num must be positive');
        }
        let count = 0;
        return text.replace(new RegExp(oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), (match) => {
          count++;
          return count === instanceNum ? newText : match;
        });
      }
      return text.split(oldText).join(newText);
    }
    case 'REPT': {
      if (values.length !== 2) {
        throw new Error('REPT expects exactly two arguments');
      }
      const text = String(values[0]);
      const times = Math.max(0, Math.floor(coerceNumber(values[1])));
      if (times > 10000) {
        throw new Error('REPT repeat count too large');
      }
      return text.repeat(times);
    }
    case 'FIND': {
      if (values.length < 2 || values.length > 3) {
        throw new Error('FIND expects two or three arguments');
      }
      const findText = String(values[0]);
      const withinText = String(values[1]);
      const startNum = values.length > 2 ? Math.max(1, Math.floor(coerceNumber(values[2]))) : 1;
      const index = withinText.indexOf(findText, startNum - 1);
      if (index === -1) {
        throw new Error('FIND: Text not found');
      }
      return index + 1;
    }
    case 'SEARCH': {
      if (values.length < 2 || values.length > 3) {
        throw new Error('SEARCH expects two or three arguments');
      }
      const findText = String(values[0]).toLowerCase();
      const withinText = String(values[1]).toLowerCase();
      const startNum = values.length > 2 ? Math.max(1, Math.floor(coerceNumber(values[2]))) : 1;
      const index = withinText.indexOf(findText, startNum - 1);
      if (index === -1) {
        throw new Error('SEARCH: Text not found');
      }
      return index + 1;
    }
    // Date functions
    case 'TODAY': {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }
    case 'NOW': {
      return new Date().toISOString();
    }
    case 'YEAR': {
      if (values.length !== 1) {
        throw new Error('YEAR expects exactly one argument');
      }
      const date = new Date(String(values[0]));
      if (isNaN(date.getTime())) {
        throw new Error('YEAR: Invalid date');
      }
      return date.getFullYear();
    }
    case 'MONTH': {
      if (values.length !== 1) {
        throw new Error('MONTH expects exactly one argument');
      }
      const date = new Date(String(values[0]));
      if (isNaN(date.getTime())) {
        throw new Error('MONTH: Invalid date');
      }
      return date.getMonth() + 1;
    }
    case 'DAY': {
      if (values.length !== 1) {
        throw new Error('DAY expects exactly one argument');
      }
      const date = new Date(String(values[0]));
      if (isNaN(date.getTime())) {
        throw new Error('DAY: Invalid date');
      }
      return date.getDate();
    }
    // Logical functions
    case 'AND': {
      if (values.length === 0) {
        throw new Error('AND expects at least one argument');
      }
      return values.every((v) => toBoolean(v));
    }
    case 'OR': {
      if (values.length === 0) {
        throw new Error('OR expects at least one argument');
      }
      return values.some((v) => toBoolean(v));
    }
    case 'NOT': {
      if (values.length !== 1) {
        throw new Error('NOT expects exactly one argument');
      }
      return !toBoolean(values[0]);
    }
    case 'ISBLANK': {
      if (values.length !== 1) {
        throw new Error('ISBLANK expects exactly one argument');
      }
      return values[0] === '' || values[0] === null || values[0] === undefined;
    }
    case 'ISNUMBER': {
      if (values.length !== 1) {
        throw new Error('ISNUMBER expects exactly one argument');
      }
      return typeof values[0] === 'number' && Number.isFinite(values[0]);
    }
    case 'ISTEXT': {
      if (values.length !== 1) {
        throw new Error('ISTEXT expects exactly one argument');
      }
      return typeof values[0] === 'string' && values[0] !== '';
    }
    // Math functions
    case 'SQRT': {
      if (values.length !== 1) {
        throw new Error('SQRT expects exactly one argument');
      }
      const num = coerceNumber(values[0]);
      if (num < 0) {
        throw new Error('SQRT: Cannot take square root of negative number');
      }
      return Math.sqrt(num);
    }
    case 'POWER':
    case 'POW': {
      if (values.length !== 2) {
        throw new Error('POWER expects exactly two arguments');
      }
      return Math.pow(coerceNumber(values[0]), coerceNumber(values[1]));
    }
    case 'MOD': {
      if (values.length !== 2) {
        throw new Error('MOD expects exactly two arguments');
      }
      const divisor = coerceNumber(values[1]);
      if (divisor === 0) {
        throw new Error('MOD: Division by zero');
      }
      return coerceNumber(values[0]) % divisor;
    }
    case 'INT': {
      if (values.length !== 1) {
        throw new Error('INT expects exactly one argument');
      }
      return Math.floor(coerceNumber(values[0]));
    }
    case 'SIGN': {
      if (values.length !== 1) {
        throw new Error('SIGN expects exactly one argument');
      }
      return Math.sign(coerceNumber(values[0]));
    }
    case 'PI': {
      return Math.PI;
    }
    case 'RAND': {
      return Math.random();
    }
    case 'RANDBETWEEN': {
      if (values.length !== 2) {
        throw new Error('RANDBETWEEN expects exactly two arguments');
      }
      const bottom = Math.floor(coerceNumber(values[0]));
      const top = Math.floor(coerceNumber(values[1]));
      if (bottom > top) {
        throw new Error('RANDBETWEEN: bottom must be less than or equal to top');
      }
      return Math.floor(Math.random() * (top - bottom + 1)) + bottom;
    }
    default:
      throw new Error(`Unsupported function ${upperName}`);
  }
}
