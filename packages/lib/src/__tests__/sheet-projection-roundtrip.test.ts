import { describe, test, expect } from 'vitest';
import { rowsFromSheetData, sheetDataFromRows } from '../sheets/projection';

describe('sheet row projection', () => {
  test('preserves formatting-only cells and all tab presentation settings across storage', () => {
    const sheet = {
      version: 1, rowCount: 20, columnCount: 8, sheetName: 'Budget',
      cells: { A1: '2', B1: '=A1*3', C2: '=1/0', D3: '=SUM(A1:B1)' },
      formats: { E5: { bold: true } },
      columnFormats: { B: { italic: true } },
      columnWidths: { B: 180 }, rowHeights: { '2': 36 },
      frozenRows: 0, frozenColumns: 2, ranges: { totals: { range: 'A1:B1' } },
    };
    const stored = rowsFromSheetData(sheet, 3);
    expect(stored.tab.tabIndex).toBe(3);
    expect(stored.rows.find(row => row.rowIndex === 4)?.cells.E).toMatchObject({ raw: '', format: { bold: true } });
    expect(stored.rows[0].cells.B).toMatchObject({ raw: '=A1*3', value: 6 });
    expect(stored.rows.find(row => row.rowIndex === 1)?.cells.C.error).toBeDefined();
    expect(stored.cellDeps).toContainEqual({ address: 'B1', dependsOn: ['A1'], dependents: [] });
    expect(stored.rangeDeps).toContainEqual({ formulaAddress: 'D3', rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 });
    expect(sheetDataFromRows(stored.tab, stored.rows)).toEqual(sheet);
  });

  test('omits absent settings and empty raw values while preserving zero freeze counts', () => {
    expect(sheetDataFromRows({ tabIndex: 0, name: 'Blank', rowCount: 5, columnCount: 3, frozenRows: 0, frozenColumns: 0 }, [
      { rowIndex: 1, cells: { A: { raw: '' } } },
    ])).toEqual({ version: 1, rowCount: 5, columnCount: 3, sheetName: 'Blank', cells: {}, frozenRows: 0, frozenColumns: 0 });
    expect(rowsFromSheetData({ version: 1, rowCount: 5, columnCount: 3, cells: {} })).toMatchObject({
      tab: { name: 'Sheet1', frozenRows: null, frozenColumns: null, columnFormats: null, columnWidths: null, rowHeights: null, ranges: null },
      rows: [], cellDeps: [], rangeDeps: [],
    });
  });
});
