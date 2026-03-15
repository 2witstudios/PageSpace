import { describe, it, expect } from 'vitest';
import { isSheetType, updateSheetCells, sanitizeSheetData, cloneCells } from '../sheets/update';
import { createEmptySheet } from '../sheets/io';
import { PageType } from '../utils/enums';

describe('isSheetType', () => {
  it('returns true for SHEET type', () => {
    expect(isSheetType(PageType.SHEET)).toBe(true);
  });

  it('returns false for DOCUMENT type', () => {
    expect(isSheetType(PageType.DOCUMENT)).toBe(false);
  });

  it('returns false for FOLDER type', () => {
    expect(isSheetType(PageType.FOLDER)).toBe(false);
  });

  it('returns false for CHANNEL type', () => {
    expect(isSheetType(PageType.CHANNEL)).toBe(false);
  });

  it('returns false for AI_CHAT type', () => {
    expect(isSheetType(PageType.AI_CHAT)).toBe(false);
  });

  it('returns false for CANVAS type', () => {
    expect(isSheetType(PageType.CANVAS)).toBe(false);
  });

  it('returns false for FILE type', () => {
    expect(isSheetType(PageType.FILE)).toBe(false);
  });

  it('returns false for TASK_LIST type', () => {
    expect(isSheetType(PageType.TASK_LIST)).toBe(false);
  });

  it('returns false for CODE type', () => {
    expect(isSheetType(PageType.CODE)).toBe(false);
  });
});

describe('cloneCells', () => {
  it('creates a shallow copy of cells', () => {
    const cells = { A1: '10', B2: '20' };
    const cloned = cloneCells(cells);
    expect(cloned).toEqual(cells);
    expect(cloned).not.toBe(cells);
  });
});

describe('updateSheetCells', () => {
  it('applies valid cell updates', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '10';

    const result = updateSheetCells(sheet, [
      { address: 'A1', value: '20' },
      { address: 'B2', value: '=A1+5' },
    ]);

    expect(result.cells.A1).toBe('20');
    expect(result.cells.B2).toBe('=A1+5');
  });

  it('removes cell when value is empty', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '10';
    sheet.cells.B2 = '20';

    const result = updateSheetCells(sheet, [
      { address: 'A1', value: '' },
    ]);

    expect(result.cells.A1).toBeUndefined();
    expect(result.cells.B2).toBe('20');
  });

  it('removes cell when value is whitespace only', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '10';

    const result = updateSheetCells(sheet, [
      { address: 'A1', value: '   ' },
    ]);

    expect(result.cells.A1).toBeUndefined();
  });

  it('throws on invalid cell address', () => {
    const sheet = createEmptySheet(5, 5);

    expect(() =>
      updateSheetCells(sheet, [{ address: 'invalid', value: '10' }])
    ).toThrow('Invalid cell address');
  });

  it('throws on numeric-only address', () => {
    const sheet = createEmptySheet(5, 5);

    expect(() =>
      updateSheetCells(sheet, [{ address: '123', value: '10' }])
    ).toThrow('Invalid cell address');
  });

  it('expands sheet dimensions when updating beyond current bounds', () => {
    const sheet = createEmptySheet(3, 3);

    const result = updateSheetCells(sheet, [
      { address: 'Z100', value: '42' },
    ]);

    expect(result.rowCount).toBeGreaterThanOrEqual(100);
    expect(result.columnCount).toBeGreaterThanOrEqual(26);
    expect(result.cells.Z100).toBe('42');
  });

  it('normalizes cell address to uppercase', () => {
    const sheet = createEmptySheet(5, 5);

    const result = updateSheetCells(sheet, [
      { address: 'a1', value: '10' },
    ]);

    expect(result.cells.A1).toBe('10');
  });

  it('handles multiple updates in sequence', () => {
    const sheet = createEmptySheet(5, 5);

    const result = updateSheetCells(sheet, [
      { address: 'A1', value: '10' },
      { address: 'A2', value: '20' },
      { address: 'A3', value: '30' },
    ]);

    expect(result.cells.A1).toBe('10');
    expect(result.cells.A2).toBe('20');
    expect(result.cells.A3).toBe('30');
  });

  it('does not mutate original sheet', () => {
    const sheet = createEmptySheet(5, 5);
    sheet.cells.A1 = '10';

    const result = updateSheetCells(sheet, [
      { address: 'A1', value: '999' },
    ]);

    expect(sheet.cells.A1).toBe('10');
    expect(result.cells.A1).toBe('999');
  });

  it('preserves original sheet rowCount/columnCount when update is within bounds', () => {
    const sheet = createEmptySheet(10, 10);

    const result = updateSheetCells(sheet, [
      { address: 'A1', value: '10' },
    ]);

    expect(result.rowCount).toBe(10);
    expect(result.columnCount).toBe(10);
  });
});

describe('sanitizeSheetData from update module', () => {
  it('removes cells that fail decodeCellAddress', () => {
    const sheet = {
      version: 1,
      rowCount: 5,
      columnCount: 5,
      cells: {
        A1: '10',
        'INVALID': 'bad',
        'Z0': 'bad row zero',
      },
    };

    const result = sanitizeSheetData(sheet);
    expect(result.cells.A1).toBe('10');
    expect(result.cells['INVALID']).toBeUndefined();
  });

  it('enforces minimum row and column counts', () => {
    const sheet = {
      version: 1,
      rowCount: -5,
      columnCount: 0,
      cells: {},
    };

    const result = sanitizeSheetData(sheet);
    expect(result.rowCount).toBeGreaterThanOrEqual(1);
    expect(result.columnCount).toBeGreaterThanOrEqual(1);
  });
});
