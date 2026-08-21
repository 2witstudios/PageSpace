/**
 * @module @pagespace/lib/sheets/projection
 * @description Conversion between stored rows and the in-memory `SheetData`.
 *
 * `SheetData` stays the shape the engine, the editor, the exporters and the
 * publisher all speak. Making the row store project into it — rather than
 * rewriting every consumer against a new shape — is what keeps this migration
 * from touching the evaluation, format and address modules at all.
 *
 * Everything here is pure. The database lives on the other side of `store.ts`;
 * these functions are what make the mapping testable without one.
 */

import type { StoredCell, CellFormat } from '@pagespace/db/schema';
import type { SheetData, SheetEvaluation, CellFormat as LibCellFormat } from './types';
import {
  decodeCellAddress,
  decodeColumnLabel,
  encodeCellAddress,
  encodeColumnLabel,
  columnLabelOf,
} from './address';
import { extractFormulaDependencies, type CellRect } from './deps';
import { evaluateSheet } from './evaluation';
import { applyNumberFormat, resolveCellFormat } from './format';
import { formatDisplayValue } from './functions';

/**
 * `CellFormat` is defined twice — here as the `jsonb` column shape in
 * `@pagespace/db`, and in `./types` as the shape the engine works with. The
 * duplication is forced: `lib` depends on `db`, so `db` cannot import from
 * `lib` and the column types have to live with the columns.
 *
 * This assertion is the guard against them drifting. Adding a field to one and
 * not the other becomes a build error here, rather than a value silently
 * dropped on write — which is how cell formatting would quietly stop
 * round-tripping through the row store.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * Keys are compared separately, and that is not redundant.
 *
 * Structural assignability alone does not see an added OPTIONAL field: a type
 * with an extra `foo?: string` is still assignable in both directions, so the
 * assignability check passes while the two definitions have genuinely diverged.
 * Since almost every field on `CellFormat` is optional, that is the *only*
 * drift shape that actually happens here.
 */
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : never) : never;

const _cellFormatContract: MutuallyAssignable<CellFormat, LibCellFormat> = true;
const _cellFormatKeys: SameKeys<CellFormat, LibCellFormat> = true;
void _cellFormatContract;
void _cellFormatKeys;

/** The stored form of one tab, minus the database bookkeeping columns. */
export interface StoredTab {
  tabIndex: number;
  name: string;
  rowCount: number;
  columnCount: number;
  frozenRows?: number | null;
  frozenColumns?: number | null;
  columnFormats?: Record<string, CellFormat> | null;
  columnWidths?: Record<string, number> | null;
  rowHeights?: Record<string, number> | null;
  ranges?: Record<string, Record<string, unknown>> | null;
}

/** The stored form of one row. */
export interface StoredRow {
  rowIndex: number;
  cells: Record<string, StoredCell>;
}

/** A formula cell's persisted dependency edges. */
export interface StoredCellDep {
  address: string;
  dependsOn: string[];
  dependents: string[];
}

/** A formula cell's persisted range edges. */
export interface StoredRangeDep {
  formulaAddress: string;
  rowStart: number;
  rowEnd: number | null;
  colStart: number;
  colEnd: number | null;
}

export interface MaterializedTab {
  tab: StoredTab;
  rows: StoredRow[];
  cellDeps: StoredCellDep[];
  rangeDeps: StoredRangeDep[];
}

/**
 * Stored rows → `SheetData`.
 *
 * Only `raw` is projected into `cells`, because that is what `SheetData.cells`
 * has always held — the authored text. The materialised `value` is deliberately
 * not folded in: a consumer that wants computed output asks the evaluator (or
 * reads `storedEvaluation` below), and silently swapping a formula for its
 * result here would make a round trip lose the formula.
 */
export function sheetDataFromRows(tab: StoredTab, rows: readonly StoredRow[]): SheetData {
  const cells: Record<string, string> = {};
  const formats: Record<string, CellFormat> = {};

  for (const row of rows) {
    for (const [label, cell] of Object.entries(row.cells ?? {})) {
      const address = `${label}${row.rowIndex + 1}`;
      if (cell.raw !== undefined && cell.raw !== '') {
        cells[address] = cell.raw;
      }
      if (cell.format) {
        formats[address] = cell.format;
      }
    }
  }

  const sheet: SheetData = {
    version: 1,
    rowCount: tab.rowCount,
    columnCount: tab.columnCount,
    cells,
    sheetName: tab.name,
  };

  if (Object.keys(formats).length > 0) sheet.formats = formats;
  if (tab.columnFormats) sheet.columnFormats = tab.columnFormats;
  if (tab.columnWidths) sheet.columnWidths = tab.columnWidths;
  if (tab.rowHeights) sheet.rowHeights = tab.rowHeights;
  if (tab.frozenRows != null) sheet.frozenRows = tab.frozenRows;
  if (tab.frozenColumns != null) sheet.frozenColumns = tab.frozenColumns;
  if (tab.ranges) sheet.ranges = tab.ranges;

  return sheet;
}

/**
 * `SheetData` → stored rows, with computed values materialised and dependency
 * edges extracted.
 *
 * This is the expensive direction — it evaluates the whole grid once — and is
 * therefore reserved for the paths that genuinely need a full rebuild: the
 * backfill, an import, and a repair. The steady-state write path in `store.ts`
 * recomputes only a dependency closure and never comes through here.
 */
export function rowsFromSheetData(sheet: SheetData, tabIndex = 0): MaterializedTab {
  const evaluation = evaluateSheet(sheet);
  const byRow = new Map<number, Record<string, StoredCell>>();

  const ensureRow = (rowIndex: number): Record<string, StoredCell> => {
    let row = byRow.get(rowIndex);
    if (!row) {
      row = {};
      byRow.set(rowIndex, row);
    }
    return row;
  };

  const addresses = new Set<string>([
    ...Object.keys(sheet.cells ?? {}),
    ...Object.keys(sheet.formats ?? {}),
  ]);

  const cellDeps: StoredCellDep[] = [];
  const rangeDeps: StoredRangeDep[] = [];

  for (const address of addresses) {
    let position: { row: number; column: number };
    try {
      position = decodeCellAddress(address);
    } catch {
      // An address the engine cannot decode cannot be stored against a row.
      // Skipping beats throwing: one bad key must not fail a whole backfill.
      continue;
    }

    const normalized = address.toUpperCase();
    const raw = sheet.cells?.[address] ?? '';
    const format = sheet.formats?.[address];
    const evaluated = evaluation.byAddress[normalized];

    const stored: StoredCell = { raw };
    if (evaluated) {
      stored.value = evaluated.value;
      stored.type = evaluated.type;
      if (evaluated.error) stored.error = { type: evaluated.error };
    }
    if (format) stored.format = format;

    ensureRow(position.row)[encodeColumnLabel(position.column)] = stored;

    if (raw.trim().startsWith('=')) {
      const deps = extractFormulaDependencies(raw);
      const record = evaluation.dependencies[normalized];
      cellDeps.push({
        address: normalized,
        dependsOn: deps.cells,
        dependents: record?.dependents ?? [],
      });
      for (const rect of deps.ranges) {
        rangeDeps.push({ formulaAddress: normalized, ...rect });
      }
    }
  }

  const rows: StoredRow[] = Array.from(byRow.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([rowIndex, cells]) => ({ rowIndex, cells }));

  return {
    tab: {
      tabIndex,
      name: sheet.sheetName ?? 'Sheet1',
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      frozenRows: sheet.frozenRows ?? null,
      frozenColumns: sheet.frozenColumns ?? null,
      columnFormats: sheet.columnFormats ?? null,
      columnWidths: sheet.columnWidths ?? null,
      rowHeights: sheet.rowHeights ?? null,
      ranges: sheet.ranges ?? null,
    },
    rows,
    cellDeps,
    rangeDeps,
  };
}

/**
 * The display grid for a set of stored rows, without re-evaluating.
 *
 * Exports and the publisher want computed values, and the whole point of
 * materialising `value` on write is that they can have them for the cost of a
 * read. Cells with no stored value fall back to their raw text, which is what a
 * literal is anyway.
 */
export function displayGridFromRows(
  tab: StoredTab,
  rows: readonly StoredRow[]
): string[][] {
  const grid: string[][] = Array.from({ length: tab.rowCount }, () =>
    Array<string>(tab.columnCount).fill('')
  );

  for (const row of rows) {
    if (row.rowIndex < 0 || row.rowIndex >= tab.rowCount) continue;
    for (const [label, cell] of Object.entries(row.cells ?? {})) {
      let column: number;
      try {
        column = decodeColumnLabel(label);
      } catch {
        continue;
      }
      if (column < 0 || column >= tab.columnCount) continue;
      grid[row.rowIndex][column] = storedDisplay(cell, tab.columnFormats?.[label]);
    }
  }

  return grid;
}

/**
 * What a stored cell shows: its error, else its formatted computed value, else
 * its raw text.
 *
 * Two distinctions that look pedantic and are not:
 *
 * `value === ''` is a COMPUTED empty string, not a missing value. Falling
 * through to `raw` for it would print the formula — `=IF(A1>0,"","x")` would
 * export as its own source text instead of as blank. Only `undefined` means
 * "nothing was materialised".
 *
 * The number format is re-applied here. `evaluateSheet` produces `display` by
 * running `applyNumberFormat` over the value, but only the unformatted `value`
 * is materialised on the row, so a currency cell would otherwise export as
 * `1234.5` rather than `$1,234.50`.
 */
export function storedDisplay(cell: StoredCell, columnFormat?: CellFormat): string {
  if (cell.error) return '#ERROR';
  if (cell.value === undefined) return cell.raw ?? '';

  // Same two steps, in the same order, as `evaluateCellInternal`: format the
  // value, then let a number format override. Diverging here would make an
  // export disagree with the grid it was exported from.
  const base = formatDisplayValue(cell.value);
  const format = resolveCellFormat(cell.format, columnFormat);
  if (!format) return base;

  const formatted = applyNumberFormat(cell.value, format.number);
  return formatted ?? base;
}

/**
 * Every address a stored row occupies, for callers that need to line rows up
 * against an evaluation keyed by A1 address.
 */
export function addressesOfRow(row: StoredRow): string[] {
  return Object.keys(row.cells ?? {}).map((label) => `${label}${row.rowIndex + 1}`);
}

// Re-exported so callers building rows do not each reimplement address maths.
export { encodeCellAddress, encodeColumnLabel, columnLabelOf };
export type { CellRect, SheetEvaluation };
