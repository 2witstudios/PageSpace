/**
 * The materialisation bound.
 *
 * `rowsFromSheetData` turns a parsed SHEETDOC into `sheet_rows`, and a document
 * is untrusted input — it arrives from a restore, an import or a paste, not
 * only from our own serializer. The write path (`normalizeUpdates`) rejects
 * out-of-range addresses; before this bound existed the document path did not,
 * so a single hostile or corrupt address either violated a `sheet_rows` CHECK
 * (aborting the whole materialisation with an opaque constraint error) or wrote
 * a row index that made any later rebuild an evaluation over billions of cells.
 */
import { describe, it, expect } from 'vitest';
import { rowsFromSheetData } from '../sheets/projection';
import { MAX_ADDRESSABLE_ROW } from '../sheets/address';
import type { SheetData } from '../sheets/types';

const sheetWith = (cells: Record<string, string>): SheetData => ({
  cells,
  rowCount: 10,
  columnCount: 5,
} as SheetData);

describe('rowsFromSheetData address bounds', () => {
  it('skips a row index beyond the addressable maximum', () => {
    const result = rowsFromSheetData(sheetWith({ A1: 'keep', [`A${MAX_ADDRESSABLE_ROW + 2}`]: 'drop' }));

    expect(result.rows.map((row) => row.rowIndex)).toEqual([0]);
    expect(result.rows[0].cells.A.raw).toBe('keep');
  });

  it('skips a row 0 address, which decodes to a negative index', () => {
    // `A0` clears every address regex and only fails at the non-negative CHECK.
    const result = rowsFromSheetData(sheetWith({ A0: 'drop', B2: 'keep' }));

    expect(result.rows.map((row) => row.rowIndex)).toEqual([1]);
    expect(result.rows[0].cells.B.raw).toBe('keep');
  });

  it('keeps the last addressable row', () => {
    const result = rowsFromSheetData(sheetWith({ [`A${MAX_ADDRESSABLE_ROW + 1}`]: 'edge' }));

    expect(result.rows.map((row) => row.rowIndex)).toEqual([MAX_ADDRESSABLE_ROW]);
  });
});
