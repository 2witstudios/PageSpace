/**
 * @module @pagespace/lib/sheets/evaluation
 * @description Sheet evaluation engine
 */

import type {
  ASTNode,
  AncestorSet,
  EvalValue,
  SheetData,
  SheetEvaluation,
  SheetEvaluationCell,
  SheetEvaluationOptions,
  SheetExternalReferenceToken,
  SheetExternalReferenceResolution,
  SheetDocDependencyRecord,
} from './types';
import { LOCAL_PAGE_KEY } from './constants';
import { encodeCellAddress, expandRange, numberRegex } from './address';
import { tokenize, FormulaParser } from './parser';
import { evaluateFunction, flattenValue, coerceNumber, formatDisplayValue } from './functions';

interface EvaluationEnvironment {
  options: SheetEvaluationOptions;
  caches: Map<string, Map<string, SheetEvaluationCell>>;
  sheets: Map<string, SheetData>;
  pageTitles: Map<string, string>;
  resolutionCache: Map<string, SheetExternalReferenceResolution>;
}

function getPageCache(
  env: EvaluationEnvironment,
  pageKey: string
): Map<string, SheetEvaluationCell> {
  let cache = env.caches.get(pageKey);
  if (!cache) {
    cache = new Map();
    env.caches.set(pageKey, cache);
  }
  return cache;
}

function getSheetForPage(env: EvaluationEnvironment, pageKey: string): SheetData {
  const sheet = env.sheets.get(pageKey);
  if (!sheet) {
    throw new Error(`Missing sheet data for page ${pageKey}`);
  }
  return sheet;
}

function formatAncestorKey(pageKey: string, address: string): string {
  return `${pageKey}|${address}`;
}

function resolveExternalSheet(
  page: SheetExternalReferenceToken,
  env: EvaluationEnvironment
): SheetExternalReferenceResolution {
  if (env.resolutionCache.has(page.raw)) {
    return env.resolutionCache.get(page.raw)!;
  }

  if (!env.options.resolveExternalReference) {
    const fallback: SheetExternalReferenceResolution = {
      pageId: page.identifier ?? page.raw,
      pageTitle: page.label,
      error: 'Cross-page references are not supported in this context',
    };
    env.resolutionCache.set(page.raw, fallback);
    return fallback;
  }

  const provided = env.options.resolveExternalReference(page);
  if (!provided) {
    const fallback: SheetExternalReferenceResolution = {
      pageId: page.identifier ?? page.raw,
      pageTitle: page.label,
      error: `Referenced page "${page.label}" is not available`,
    };
    env.resolutionCache.set(page.raw, fallback);
    return fallback;
  }

  const normalized: SheetExternalReferenceResolution = {
    pageId: provided.pageId || page.identifier || page.raw,
    pageTitle: provided.pageTitle || page.label,
    sheet: provided.sheet,
    error: provided.error,
  };

  env.resolutionCache.set(page.raw, normalized);

  if (normalized.sheet) {
    env.sheets.set(normalized.pageId, normalized.sheet);
    if (!env.caches.has(normalized.pageId)) {
      env.caches.set(normalized.pageId, new Map());
    }
    if (!env.pageTitles.has(normalized.pageId)) {
      env.pageTitles.set(normalized.pageId, normalized.pageTitle);
    }
  }

  return normalized;
}

function collectDependencies(node: ASTNode): string[] {
  const references = new Set<string>();

  const visit = (current: ASTNode) => {
    switch (current.type) {
      case 'CellReference': {
        const normalized = normalizeDependencyReference(current.reference);
        if (normalized) {
          references.add(normalized);
        }
        break;
      }
      case 'Range': {
        const expanded = expandRange(current.start.reference, current.end.reference);
        for (const address of expanded) {
          const normalized = normalizeDependencyReference(address);
          if (normalized) {
            references.add(normalized);
          }
        }
        break;
      }
      case 'ExternalCellReference': {
        const formatted = formatExternalReference(current.page, current.reference);
        const normalized = normalizeDependencyReference(formatted);
        if (normalized) {
          references.add(normalized);
        }
        break;
      }
      case 'ExternalRange': {
        const expanded = expandRange(current.start.reference, current.end.reference);
        for (const address of expanded) {
          const formatted = formatExternalReference(current.page, address);
          const normalized = normalizeDependencyReference(formatted);
          if (normalized) {
            references.add(normalized);
          }
        }
        break;
      }
      case 'UnaryExpression': {
        visit(current.argument);
        break;
      }
      case 'BinaryExpression': {
        visit(current.left);
        visit(current.right);
        break;
      }
      case 'FunctionCall': {
        for (const arg of current.args) {
          visit(arg);
        }
        break;
      }
      default:
        break;
    }
  };

  visit(node);
  return Array.from(references);
}

interface NodeEvaluationContext {
  getCell: (reference: string, ancestors: AncestorSet) => SheetEvaluationCell;
  getExternalCell: (
    page: SheetExternalReferenceToken,
    reference: string,
    ancestors: AncestorSet
  ) => SheetEvaluationCell;
}

function evaluateNode(node: ASTNode, context: NodeEvaluationContext, ancestors: AncestorSet): EvalValue {
  switch (node.type) {
    case 'NumberLiteral':
      return node.value;
    case 'StringLiteral':
      return node.value;
    case 'BooleanLiteral':
      return node.value;
    case 'CellReference': {
      const cell = context.getCell(node.reference, ancestors);
      if (cell.error) {
        throw new Error(cell.error);
      }
      return cell.value;
    }
    case 'Range': {
      const addresses = expandRange(node.start.reference, node.end.reference);
      return addresses.map((address) => {
        const cell = context.getCell(address, ancestors);
        if (cell.error) {
          throw new Error(cell.error);
        }
        return cell.value;
      });
    }
    case 'ExternalCellReference': {
      const cell = context.getExternalCell(node.page, node.reference, ancestors);
      if (cell.error) {
        throw new Error(cell.error);
      }
      return cell.value;
    }
    case 'ExternalRange': {
      const addresses = expandRange(node.start.reference, node.end.reference);
      return addresses.map((address) => {
        const cell = context.getExternalCell(node.page, address, ancestors);
        if (cell.error) {
          throw new Error(cell.error);
        }
        return cell.value;
      });
    }
    case 'UnaryExpression': {
      const argument = evaluateNode(node.argument, context, ancestors);
      const value = flattenValue(argument)[0];
      const numeric = coerceNumber(value);
      return node.operator === '-' ? -numeric : numeric;
    }
    case 'BinaryExpression': {
      const leftValue = flattenValue(evaluateNode(node.left, context, ancestors))[0];
      const rightValue = flattenValue(evaluateNode(node.right, context, ancestors))[0];

      switch (node.operator) {
        case '+': {
          try {
            const numericLeft = coerceNumber(leftValue);
            const numericRight = coerceNumber(rightValue);
            return numericLeft + numericRight;
          } catch {
            return `${formatDisplayValue(leftValue)}${formatDisplayValue(rightValue)}`;
          }
        }
        case '-':
          return coerceNumber(leftValue) - coerceNumber(rightValue);
        case '*':
          return coerceNumber(leftValue) * coerceNumber(rightValue);
        case '/': {
          const denominator = coerceNumber(rightValue);
          if (denominator === 0) {
            throw new Error('Division by zero');
          }
          return coerceNumber(leftValue) / denominator;
        }
        case '^':
          return Math.pow(coerceNumber(leftValue), coerceNumber(rightValue));
        case '&':
          return `${formatDisplayValue(leftValue)}${formatDisplayValue(rightValue)}`;
        case '=': {
          try {
            return coerceNumber(leftValue) === coerceNumber(rightValue);
          } catch {
            return formatDisplayValue(leftValue) === formatDisplayValue(rightValue);
          }
        }
        case '>':
          return coerceNumber(leftValue) > coerceNumber(rightValue);
        case '<':
          return coerceNumber(leftValue) < coerceNumber(rightValue);
        case '>=':
          return coerceNumber(leftValue) >= coerceNumber(rightValue);
        case '<=':
          return coerceNumber(leftValue) <= coerceNumber(rightValue);
        case '<>': {
          try {
            return coerceNumber(leftValue) !== coerceNumber(rightValue);
          } catch {
            return formatDisplayValue(leftValue) !== formatDisplayValue(rightValue);
          }
        }
        default:
          throw new Error('Unsupported operator');
      }
    }
    case 'FunctionCall': {
      return evaluateFunction(node.name, node.args, (child) => evaluateNode(child, context, ancestors));
    }
    default:
      throw new Error('Unsupported expression');
  }
}

function evaluateExternalReferenceCell(
  page: SheetExternalReferenceToken,
  address: string,
  env: EvaluationEnvironment,
  ancestors: AncestorSet
): SheetEvaluationCell {
  const resolution = resolveExternalSheet(page, env);
  if (!resolution.sheet || resolution.error) {
    return {
      address: address.toUpperCase(),
      raw: '',
      value: '',
      display: '#ERROR',
      type: 'empty',
      error:
        resolution.error ?? `Referenced page "${page.label}" is not available`,
      dependsOn: [],
      dependents: [],
    };
  }

  return evaluateCellInternal(address, resolution.pageId, env, ancestors);
}

function evaluateCellInternal(
  address: string,
  pageKey: string,
  env: EvaluationEnvironment,
  ancestors: AncestorSet
): SheetEvaluationCell {
  const normalized = address.toUpperCase();
  const cache = getPageCache(env, pageKey);

  if (cache.has(normalized)) {
    return cache.get(normalized)!;
  }

  const ancestorKey = formatAncestorKey(pageKey, normalized);
  if (ancestors.has(ancestorKey)) {
    const sheet = getSheetForPage(env, pageKey);
    const circular: SheetEvaluationCell = {
      address: normalized,
      raw: sheet.cells[normalized] ?? '',
      value: '',
      display: '#CYCLE',
      type: 'empty',
      error: 'Circular reference detected',
      dependsOn: [],
      dependents: [],
    };
    cache.set(normalized, circular);
    return circular;
  }

  const sheet = getSheetForPage(env, pageKey);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(ancestorKey);

  const rawInput = sheet.cells[normalized] ?? '';
  const trimmed = rawInput.trim();

  let result: SheetEvaluationCell;

  if (!trimmed) {
    result = {
      address: normalized,
      raw: rawInput,
      value: '',
      display: '',
      type: 'empty',
      dependsOn: [],
      dependents: [],
    };
  } else if (trimmed.startsWith('=')) {
    const formula = trimmed.slice(1);
    let dependencies: string[] = [];
    try {
      const tokens = tokenize(formula);
      if (tokens.length === 0) {
        throw new Error('Empty formula');
      }
      const parser = new FormulaParser(tokens);
      const ast = parser.parse();
      dependencies = uniqueSorted(collectDependencies(ast));
      const evaluated = evaluateNode(
        ast,
        {
          getCell: (reference, ancestorsSet) =>
            evaluateCellInternal(reference, pageKey, env, ancestorsSet),
          getExternalCell: (pageRef, reference, ancestorsSet) =>
            evaluateExternalReferenceCell(pageRef, reference, env, ancestorsSet),
        },
        nextAncestors
      );
      const value = flattenValue(evaluated)[0];
      const type =
        value === ''
          ? 'empty'
          : typeof value === 'number'
          ? 'number'
          : typeof value === 'boolean'
          ? 'boolean'
          : 'string';
      result = {
        address: normalized,
        raw: rawInput,
        value,
        display: formatDisplayValue(value),
        type,
        dependsOn: dependencies,
        dependents: [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Formula error';
      result = {
        address: normalized,
        raw: rawInput,
        value: '',
        display: '#ERROR',
        type: 'empty',
        error: message,
        dependsOn: dependencies,
        dependents: [],
      };
    }
  } else if (numberRegex.test(trimmed)) {
    const numericValue = Number(trimmed);
    result = {
      address: normalized,
      raw: rawInput,
      value: numericValue,
      display: formatDisplayValue(numericValue),
      type: 'number',
      dependsOn: [],
      dependents: [],
    };
  } else {
    result = {
      address: normalized,
      raw: rawInput,
      value: rawInput,
      display: rawInput,
      type: 'string',
      dependsOn: [],
      dependents: [],
    };
  }

  cache.set(normalized, result);
  return result;
}

/**
 * Evaluate a sheet and return all cell values, displays, and errors
 */
export function evaluateSheet(
  sheet: SheetData,
  options: SheetEvaluationOptions = {}
): SheetEvaluation {
  const rowCount = Math.max(1, sheet.rowCount);
  const columnCount = Math.max(1, sheet.columnCount);
  const pageKey = options.pageId ?? LOCAL_PAGE_KEY;
  const env: EvaluationEnvironment = {
    options,
    caches: new Map([[pageKey, new Map()]]),
    sheets: new Map([[pageKey, sheet]]),
    pageTitles: new Map([[pageKey, options.pageTitle ?? 'Sheet']]),
    resolutionCache: new Map(),
  };
  const byAddress: Record<string, SheetEvaluationCell> = {};
  const display: string[][] = Array.from({ length: rowCount }, () => Array(columnCount).fill(''));
  const errors: (string | null)[][] = Array.from({ length: rowCount }, () => Array(columnCount).fill(null));

  for (let row = 0; row < rowCount; row++) {
    for (let column = 0; column < columnCount; column++) {
      const address = encodeCellAddress(row, column);
      const cell = evaluateCellInternal(address, pageKey, env, new Set());
      byAddress[address] = cell;
      display[row][column] = cell.error ? '#ERROR' : cell.display;
      errors[row][column] = cell.error ?? null;
    }
  }

  for (const cell of Object.values(byAddress)) {
    for (const dependency of cell.dependsOn) {
      const target = byAddress[dependency];
      if (!target) {
        continue;
      }
      if (!target.dependents.includes(cell.address)) {
        target.dependents = [...target.dependents, cell.address];
      }
    }
  }

  const dependencies: Record<string, SheetDocDependencyRecord> = {};

  for (const cell of Object.values(byAddress)) {
    cell.dependsOn = uniqueSorted(cell.dependsOn);
    cell.dependents = uniqueSorted(cell.dependents);
    dependencies[cell.address] = {
      dependsOn: cell.dependsOn,
      dependents: cell.dependents,
    };
  }

  return {
    byAddress,
    display,
    errors,
    dependencies,
  };
}

// Internal helper functions

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function normalizeDependencyReference(reference: string | undefined): string | null {
  if (!reference) {
    return null;
  }

  const trimmed = reference.trim();
  if (!trimmed) {
    return null;
  }

  const upper = trimmed.toUpperCase();
  if (/^[A-Z]+\d+$/.test(upper)) {
    return upper;
  }

  const match = trimmed.match(
    /^@\[(?<label>[^\]]+)\](?:\((?<identifier>[^):]+)(?::(?<mentionType>[^)]+))?\))?:(?<address>[A-Z]+\d+)$/i
  );
  if (!match || !match.groups) {
    return null;
  }

  const label = (match.groups.label ?? '').trim();
  if (!label) {
    return null;
  }

  const identifier = match.groups.identifier ? match.groups.identifier.trim() : undefined;
  const mentionType = match.groups.mentionType ? match.groups.mentionType.trim() : undefined;
  const address = match.groups.address ? match.groups.address.toUpperCase() : undefined;

  if (!address || !/^[A-Z]+\d+$/.test(address)) {
    return null;
  }

  const idPart = identifier ? `(${identifier}${mentionType ? `:${mentionType}` : ''})` : '';
  return `@[${label}]${idPart}:${address}`;
}

function formatExternalReference(page: SheetExternalReferenceToken, address: string): string {
  const normalizedAddress = address.toUpperCase();
  const label = page.label.trim();
  const identifier = page.identifier?.trim();
  const mentionType = page.mentionType?.trim();
  const idPart = identifier ? `(${identifier}${mentionType ? `:${mentionType}` : ''})` : '';
  return `@[${label}]${idPart}:${normalizedAddress}`;
}
