/**
 * @module @pagespace/lib/sheets/external
 * @description External sheet reference collection
 */

import type { ASTNode, SheetData, SheetExternalReferenceToken } from './types';
import { tokenize, FormulaParser } from './parser';

/**
 * Collect external references from a sheet's formulas
 */
export function collectExternalReferences(
  sheet: SheetData
): SheetExternalReferenceToken[] {
  const references = new Map<string, SheetExternalReferenceToken>();

  for (const value of Object.values(sheet.cells)) {
    const rawValue = typeof value === 'string' ? value : String(value ?? '');
    const trimmed = rawValue.trim();
    if (!trimmed.startsWith('=')) {
      continue;
    }

    const formula = trimmed.slice(1);
    try {
      const tokens = tokenize(formula);
      if (tokens.length === 0) {
        continue;
      }
      const parser = new FormulaParser(tokens);
      const ast = parser.parse();
      collectExternalReferencesFromNode(ast, references);
    } catch {
      continue;
    }
  }

  return Array.from(references.values());
}

/**
 * Walk an AST and collect external references
 */
function collectExternalReferencesFromNode(
  node: ASTNode,
  references: Map<string, SheetExternalReferenceToken>
): void {
  switch (node.type) {
    case 'ExternalCellReference':
      if (!references.has(node.page.raw)) {
        references.set(node.page.raw, node.page);
      }
      break;
    case 'ExternalRange':
      if (!references.has(node.page.raw)) {
        references.set(node.page.raw, node.page);
      }
      break;
    case 'UnaryExpression':
      collectExternalReferencesFromNode(node.argument, references);
      break;
    case 'BinaryExpression':
      collectExternalReferencesFromNode(node.left, references);
      collectExternalReferencesFromNode(node.right, references);
      break;
    case 'FunctionCall':
      for (const arg of node.args) {
        collectExternalReferencesFromNode(arg, references);
      }
      break;
    default:
      break;
  }
}
