import { describe, it, expect } from 'vitest';
import { createEmptySheet } from '../sheets/io';
import { evaluateSheet, evaluateSheetSparse } from '../sheets/evaluation';
import { regionTheme, columnRoleFormat } from '../sheets/region-format';
import { numberFormatToExcelCode } from '../sheets/format';
import type { SheetData } from '../sheets/types';

/** A small budget: header row, a money column, a total row. */
const budget = (): SheetData => {
  const sheet = createEmptySheet();
  sheet.rowCount = 10;
  sheet.cells = {
    A1: 'Item',
    B1: 'Cost',
    A2: 'Rent',
    B2: '1200',
    A3: 'Coffee',
    B3: '48.5',
    A4: 'Total',
    B4: '=SUM(B2:B3)',
  };
  sheet.regions = [
    {
      id: 'budget',
      range: 'A1:B',
      headerRows: 1,
      totalRows: [4],
      theme: 'blue',
      columns: [{ column: 'B', role: 'currency' }],
    },
  ];
  return sheet;
};

describe('regions through the evaluator', () => {
  it('formats a sheet that has regions and no conditional rules at all', () => {
    // The common case, and the one a rules-focused suite misses: with no rules
    // this takes the plain display projection, not applyConditionalFormats.
    const sheet = budget();
    expect(sheet.conditionalFormats).toBeUndefined();

    const result = evaluateSheet(sheet);
    expect(result.byAddress.B2.display).toBe('$1,200.00');
    expect(result.byAddress.B1.format?.bold).toBe(true);
  });

  it('formats identically through the sparse evaluator', () => {
    // Two renderings of one sheet disagreeing is the failure this shares a
    // projection to avoid.
    const sheet = budget();
    const dense = evaluateSheet(sheet);
    const sparse = evaluateSheetSparse(sheet);
    for (const address of ['A1', 'B1', 'B2', 'B4']) {
      expect(sparse.byAddress[address]?.format).toEqual(dense.byAddress[address]?.format);
      expect(sparse.byAddress[address]?.display).toEqual(dense.byAddress[address]?.display);
    }
  });

  it('formats the computed total, not just the typed cells', () => {
    const result = evaluateSheet(budget());
    expect(result.byAddress.B4.value).toBe(1248.5);
    expect(result.byAddress.B4.display).toBe('$1,248.50');
    expect(result.byAddress.B4.format?.bold).toBe(true);
    expect(result.byAddress.B4.format?.background).toBe(regionTheme('blue').total.background);
  });

  it('leaves the header text unformatted as a number', () => {
    const result = evaluateSheet(budget());
    expect(result.byAddress.B1.display).toBe('Cost');
    expect(result.byAddress.B1.format?.number).toBeUndefined();
  });

  it('never rewrites value, only display', () => {
    // Formatting `value` would make ="Total: "&B2 embed a currency symbol.
    const result = evaluateSheet(budget());
    expect(result.byAddress.B2.value).toBe(1200);
  });

  it('covers rows added after the region was declared', () => {
    // The row-append property, end to end: nothing about the region changes.
    const sheet = budget();
    sheet.rowCount = 400;
    sheet.cells.B380 = '99';
    const result = evaluateSheet(sheet);
    expect(result.byAddress.B380.display).toBe('$99.00');
  });

  it('resolves all four layers weakest to strongest', () => {
    const sheet = budget();
    sheet.columnFormats = { B: { background: '#f1f5f9', italic: true } };
    sheet.formats = { B2: { background: '#dcfce7' } };
    sheet.conditionalFormats = [
      {
        id: 'over',
        kind: 'cell',
        ranges: ['B2:B3'],
        condition: { operator: 'greaterThan', value: '1000' },
        format: { background: '#fee2e2' },
      },
    ];

    const at = (address: string) => evaluateSheet(sheet).byAddress[address].format;

    // B2 matches the rule, so the rule's fill wins over the explicit one.
    expect(at('B2')?.background).toBe('#fee2e2');
    // ...while fields no layer above sets still come from below.
    expect(at('B2')?.italic).toBe(true);
    expect(at('B2')?.number).toEqual(columnRoleFormat({ column: 'B', role: 'currency' }).number);

    // B3 does not match, so the explicit format is the strongest layer present.
    sheet.formats = { B3: { background: '#dcfce7' } };
    expect(at('B3')?.background).toBe('#dcfce7');

    // With no explicit format, the region beats the column default — asserted on
    // a field they BOTH set, or the ordering between them is invisible.
    sheet.formats = {};
    sheet.conditionalFormats = [];
    sheet.regions = [
      { id: 'r', range: 'B1:B', headerRows: 1, theme: 'blue', columns: [{ column: 'B', role: 'percent' }] },
    ];
    expect(at('B1')?.background).toBe(regionTheme('blue').header.background);
    expect(at('B1')?.background).not.toBe('#f1f5f9');
    // ...while a field only the column sets still survives.
    expect(at('B2')?.background).toBe('#f1f5f9');
    expect(at('B2')?.number?.kind).toBe('percent');
  });

  it('carries a region-derived number format into the XLSX export path', () => {
    // The export route reads `byAddress[addr].format.number` and passes it
    // through `numberFormatToExcelCode`, so a region's currency column must
    // export as REAL Excel currency — a workbook that cannot sum its own money
    // column is a decorative export.
    //
    // Only this half survives: the themed header fill and bold do not, because
    // xlsx@0.18.5 (community) does not write cell styles. See the note in
    // packages/lib/src/content/export-utils.ts.
    const result = evaluateSheet(budget());
    expect(numberFormatToExcelCode(result.byAddress.B2.format?.number)).toBe('"$"#,##0.00');
    // The header is text, so it carries no number format to export.
    expect(numberFormatToExcelCode(result.byAddress.B1.format?.number)).toBeUndefined();
  });

  it('costs nothing on a sheet with no regions', () => {
    const sheet = budget();
    delete sheet.regions;
    const result = evaluateSheet(sheet);
    expect(result.byAddress.B2.display).toBe('1200');
    expect(result.byAddress.B2.format).toBeUndefined();
  });
});
