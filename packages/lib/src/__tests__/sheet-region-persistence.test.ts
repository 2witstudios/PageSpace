import { describe, it, expect } from 'vitest';
import { createEmptySheet, parseSheetContent, serializeSheetContent } from '../sheets/io';
import { rowsFromSheetData, sheetDataFromRows } from '../sheets/projection';
import { sanitizeSheetData } from '../sheets/update';
import type { SheetRegion } from '../sheets/regions';
import type { SheetData } from '../sheets/types';

const withRegions = (regions: SheetRegion[]): SheetData => {
  const sheet = createEmptySheet();
  sheet.cells = { A1: 'Item', B1: 'Cost', A2: 'Rent', B2: '1200' };
  sheet.regions = regions;
  return sheet;
};

const budget: SheetRegion = {
  id: 'budget',
  name: 'Q3 Budget',
  range: 'A1:B',
  headerRows: 1,
  totalRows: [8],
  theme: 'blue',
  freezeHeader: true,
  columns: [{ column: 'B', role: 'currency', currency: 'EUR', decimals: 0 }],
};

describe('regions through the document', () => {
  it('survives serialize -> parse unchanged', () => {
    const round = parseSheetContent(serializeSheetContent(withRegions([budget])));
    expect(round.regions).toEqual([budget]);
  });

  it('keeps region order, which is precedence', () => {
    const a: SheetRegion = { id: 'a', range: 'A1:C9' };
    const b: SheetRegion = { id: 'b', range: 'A1:C9' };
    const round = parseSheetContent(serializeSheetContent(withRegions([a, b])));
    expect(round.regions?.map((region) => region.id)).toEqual(['a', 'b']);
  });

  it('carries a field a newer build wrote', () => {
    // Dropping what we do not understand turns a save into silent data loss.
    const future = { ...budget, sparkline: { column: 'C' } } as SheetRegion;
    const round = parseSheetContent(serializeSheetContent(withRegions([future])));
    expect(round.regions?.[0]).toMatchObject({ sparkline: { column: 'C' } });
  });

  it('does not resurface as a user-defined named range', () => {
    const round = parseSheetContent(serializeSheetContent(withRegions([budget])));
    expect(round.ranges?.__regions).toBeUndefined();
  });

  it('leaves a sheet with no regions with no region key', () => {
    const sheet = createEmptySheet();
    sheet.cells = { A1: 'x' };
    expect(parseSheetContent(serializeSheetContent(sheet)).regions).toBeUndefined();
  });

  it('is preserved by sanitizeSheetData', () => {
    // Validating a closed set here would let an older client delete a role a
    // newer build wrote.
    const sheet = withRegions([budget]);
    expect(sanitizeSheetData(sheet).regions).toEqual([budget]);
  });
});

describe('regions through the row store projection', () => {
  it('round trips sheet -> rows -> sheet', () => {
    const sheet = withRegions([budget]);
    const materialized = rowsFromSheetData(sheet);
    expect(materialized.tab.regions).toEqual([budget]);

    const back = sheetDataFromRows(materialized.tab, materialized.rows);
    expect(back.regions).toEqual([budget]);
  });

  it('drops an unusable stored region rather than rendering it', () => {
    const back = sheetDataFromRows(
      { tabIndex: 0, name: 'Sheet1', rowCount: 10, columnCount: 5, regions: [{ id: '', range: 'A1' }] },
      []
    );
    expect(back.regions).toBeUndefined();
  });

  it('treats a null regions column as no regions', () => {
    const back = sheetDataFromRows(
      { tabIndex: 0, name: 'Sheet1', rowCount: 10, columnCount: 5, regions: null },
      []
    );
    expect(back.regions).toBeUndefined();
  });
});
