/**
 * @module @pagespace/lib/sheets/deps
 * @description Formula dependency extraction for incremental recompute.
 *
 * The evaluator's own `collectDependencies` expands every range into its
 * individual addresses, because it needs concrete cells to read. That is the
 * wrong shape to *persist*: `=SUM(D1:D100000)` would become 100,000 dependency
 * edges for one formula, which reintroduces exactly the O(sheet) write this
 * storage model exists to remove.
 *
 * So this module walks the same AST and keeps a range as a rectangle. A write
 * to some cell then finds its dependent formulas with one indexed containment
 * query per tab instead of a 100,000-row lookup table.
 *
 * Note that ranges here are always bounded: `FormulaParser.parseRange` rejects
 * anything whose endpoints are not cell addresses, so `D:D` is a parse error
 * today and no unbounded case can reach storage. The rectangle's open end is
 * still modelled (`null`) so that support could be added without a migration.
 */

import type { ASTNode } from './types';
import { tokenize, FormulaParser } from './parser';
import { decodeCellAddress } from './address';

/** A rectangle of cells a formula reads, in 0-based inclusive coordinates. */
export interface CellRect {
  rowStart: number;
  /** `null` means "to the end of the sheet". Unreachable today; see module doc. */
  rowEnd: number | null;
  colStart: number;
  colEnd: number | null;
}

export interface FormulaDependencies {
  /** Individual local cell addresses the formula reads, normalized upper-case. */
  cells: string[];
  /** Ranges the formula reads, kept whole rather than expanded. */
  ranges: CellRect[];
  /**
   * References into other pages, kept verbatim in `@[label](id):A1` form.
   * Cross-page recompute is not incremental — see `store.ts`.
   */
  external: string[];
}

/**
 * Frozen, and its arrays with it. This value is returned by reference for every
 * non-formula, and callers put `deps.cells` straight into insert values — a
 * shared mutable array there is a trap waiting for the first caller that sorts
 * or pushes in place.
 */
const EMPTY: FormulaDependencies = Object.freeze({
  cells: Object.freeze([]) as unknown as string[],
  ranges: Object.freeze([]) as unknown as CellRect[],
  external: Object.freeze([]) as unknown as string[],
}) as FormulaDependencies;

/**
 * Parse `formula` and report what it reads.
 *
 * Returns empty dependencies for a non-formula or an unparseable one: a cell
 * whose formula does not parse has no edges to walk, and it will surface its
 * own error at evaluation time. Throwing here would make one bad cell fail the
 * whole sheet's dependency rebuild.
 */
export function extractFormulaDependencies(formula: string): FormulaDependencies {
  if (typeof formula !== 'string') return EMPTY;
  const trimmed = formula.trim();
  if (!trimmed.startsWith('=')) return EMPTY;

  let ast: ASTNode;
  try {
    ast = new FormulaParser(tokenize(trimmed.slice(1))).parse();
  } catch {
    return EMPTY;
  }

  const cells = new Set<string>();
  const external = new Set<string>();
  const ranges: CellRect[] = [];

  const visit = (node: ASTNode | undefined): void => {
    if (!node || typeof node !== 'object') return;

    switch (node.type) {
      case 'CellReference': {
        const normalized = normalizeAddress(node.reference);
        if (normalized) cells.add(normalized);
        return;
      }
      case 'Range': {
        const rect = rectOf(node.start?.reference, node.end?.reference);
        if (rect) ranges.push(rect);
        return;
      }
      case 'ExternalCellReference':
      case 'ExternalRange': {
        // Cross-page edges are recorded flat: a change in another page is not
        // something this page's write path observes, so there is nothing to
        // walk incrementally. Recorded so the reference is not simply lost.
        const raw = JSON.stringify(node);
        external.add(raw.slice(0, 512));
        return;
      }
      default:
        break;
    }

    for (const value of Object.values(node as unknown as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const entry of value) visit(entry as ASTNode);
      } else if (value && typeof value === 'object') {
        visit(value as ASTNode);
      }
    }
  };

  visit(ast);

  return {
    cells: Array.from(cells).sort(),
    ranges,
    external: Array.from(external).sort(),
  };
}

/** True when `(row, col)` falls inside `rect`, treating a null end as open. */
export function rectContains(rect: CellRect, row: number, col: number): boolean {
  if (row < rect.rowStart) return false;
  if (rect.rowEnd !== null && row > rect.rowEnd) return false;
  if (col < rect.colStart) return false;
  if (rect.colEnd !== null && col > rect.colEnd) return false;
  return true;
}

function normalizeAddress(reference: string | undefined): string | null {
  if (!reference) return null;
  const upper = reference.trim().toUpperCase().replace(/\$/g, '');
  return /^[A-Z]+\d+$/.test(upper) ? upper : null;
}

function rectOf(start: string | undefined, end: string | undefined): CellRect | null {
  const a = normalizeAddress(start);
  const b = normalizeAddress(end);
  if (!a || !b) return null;

  try {
    const from = decodeCellAddress(a);
    const to = decodeCellAddress(b);
    return {
      rowStart: Math.min(from.row, to.row),
      rowEnd: Math.max(from.row, to.row),
      colStart: Math.min(from.column, to.column),
      colEnd: Math.max(from.column, to.column),
    };
  } catch {
    return null;
  }
}
