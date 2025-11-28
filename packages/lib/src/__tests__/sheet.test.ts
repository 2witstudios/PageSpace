import { describe, it, expect } from 'vitest';
import {
  SHEETDOC_MAGIC,
  createEmptySheet,
  decodeCellAddress,
  encodeCellAddress,
  evaluateSheet,
  collectExternalReferences,
  parseSheetDocString,
  parseSheetContent,
  sanitizeSheetData,
  serializeSheetContent,
  SheetData,
} from '../sheets/sheet';

const getDisplay = (evaluation: ReturnType<typeof evaluateSheet>, address: string) => {
  return evaluation.byAddress[address]?.display;
};

const getError = (evaluation: ReturnType<typeof evaluateSheet>, address: string) => {
  return evaluation.byAddress[address]?.error;
};

describe('sheet data helpers', () => {
  it('encodes and decodes cell addresses consistently', () => {
    const pairs: Array<[number, number, string]> = [
      [0, 0, 'A1'],
      [4, 27, 'AB5'],
      [25, 0, 'A26'],
      [12, 51, 'AZ13'],
    ];

    for (const [row, column, expected] of pairs) {
      const encoded = encodeCellAddress(row, column);
      expect(encoded).toBe(expected);
      const decoded = decodeCellAddress(encoded);
      expect(decoded.row).toBe(row);
      expect(decoded.column).toBe(column);
    }
  });

  it('parses unknown content formats into a normalized sheet', () => {
    const jsonString = JSON.stringify({
      version: 3,
      rowCount: 7.9,
      columnCount: 4.2,
      cells: {
        a1: '42',
        b2: 3,
        invalid: 'ignored',
      },
    });

    const parsed = parseSheetContent(jsonString);
    expect(parsed.version).toBe(3);
    expect(parsed.rowCount).toBe(7);
    expect(parsed.columnCount).toBe(4);
    expect(parsed.cells.A1).toBe('42');
    expect(parsed.cells.B2).toBe('3');
    expect(parsed.cells.invalid).toBeUndefined();

    const sanitized = sanitizeSheetData(parsed);
    const serialized = serializeSheetContent(sanitized);
    expect(serialized.trimStart().startsWith(SHEETDOC_MAGIC)).toBe(true);

    const sheetDoc = parseSheetDocString(serialized);
    expect(sheetDoc.sheets.length > 0).toBe(true);
    const primarySheet = sheetDoc.sheets[0];
    expect(primarySheet.cells.A1?.value).toBe(42);
    expect(primarySheet.cells.B2?.value).toBe(3);

    const roundTripped = parseSheetContent(serialized);
    expect(roundTripped.version).toBe(1);
    expect(roundTripped.rowCount).toBe(sanitized.rowCount);
    expect(roundTripped.columnCount).toBe(sanitized.columnCount);
    expect(roundTripped.cells).toEqual(sanitized.cells);
  });
});

describe('sheet evaluation', () => {
  const buildSampleSheet = (): SheetData => {
    const sheet = createEmptySheet(10, 5);
    sheet.cells.A1 = '10';
    sheet.cells.A2 = '5';
    sheet.cells.A3 = '=A1+A2';
    sheet.cells.A4 = '=A1>A2';
    sheet.cells.B1 = 'Hello';
    sheet.cells.B2 = '=B1 & " World"';
    sheet.cells.B3 = '=A1/A2';
    sheet.cells.C1 = '=SUM(A1:A3)';
    sheet.cells.C2 = '=AVERAGE(A1:A2)';
    sheet.cells.C3 = '=IF(A3>20, "big", "small")';
    sheet.cells.C4 = '=COUNTA(A1:B4)';
    sheet.cells.C5 = '=COUNT(A1:B4)';
    sheet.cells.D1 = '=MAX(A1:A3)';
    sheet.cells.D2 = '=MIN(A1:A2)';
    sheet.cells.D3 = '=ABS(-3)';
    sheet.cells.D4 = '=ROUND(5.678, 2)';
    sheet.cells.D5 = '=FLOOR(5.7, 0.5)';
    sheet.cells.D6 = '=CEILING(5.1, 0.5)';
    sheet.cells.E1 = '=IF(A3=15, "exact", "nope")';
    sheet.cells.E2 = '=IF(A4, "true", "false")';
    return sheet;
  };

  it('evaluates formulas, ranges, and functions', () => {
    const evaluation = evaluateSheet(buildSampleSheet());

    expect(getDisplay(evaluation, 'A3')).toBe('15');
    expect(getDisplay(evaluation, 'B2')).toBe('Hello World');
    expect(getDisplay(evaluation, 'B3')).toBe('2');
    expect(getDisplay(evaluation, 'C1')).toBe('30');
    expect(getDisplay(evaluation, 'C2')).toBe('7.5');
    expect(getDisplay(evaluation, 'C3')).toBe('small');
    expect(getDisplay(evaluation, 'C4')).toBe('7');
    expect(getDisplay(evaluation, 'C5')).toBe('5');
    expect(getDisplay(evaluation, 'D1')).toBe('15');
    expect(getDisplay(evaluation, 'D2')).toBe('5');
    expect(getDisplay(evaluation, 'D3')).toBe('3');
    expect(getDisplay(evaluation, 'D4')).toBe('5.68');
    expect(getDisplay(evaluation, 'D5')).toBe('5.5');
    expect(getDisplay(evaluation, 'D6')).toBe('5.5');
    expect(getDisplay(evaluation, 'E1')).toBe('exact');
    expect(getDisplay(evaluation, 'E2')).toBe('true');

    expect(getError(evaluation, 'A3')).toBeUndefined();
    expect(getError(evaluation, 'C1')).toBeUndefined();
  });

  it('propagates formula errors and detects circular references', () => {
    const sheet = createEmptySheet(4, 4);
    sheet.cells.A1 = '=1/0';
    sheet.cells.A2 = '=A1+1';
    sheet.cells.B1 = '=A1';
    sheet.cells.B2 = '=B2+1';

    const evaluation = evaluateSheet(sheet);

    expect(getDisplay(evaluation, 'A1')).toBe('#ERROR');
    expect(getError(evaluation, 'A1')).toBe('Division by zero');
    expect(getDisplay(evaluation, 'B1')).toBe('#ERROR');
    expect(getError(evaluation, 'B1')).toBe('Division by zero');
    expect(getDisplay(evaluation, 'B2')).toBe('#ERROR');
    expect(getError(evaluation, 'B2')).toBe('Circular reference detected');
  });

  it('exposes dependency metadata and serializes SheetDoc values', () => {
    const sheet = createEmptySheet(3, 3);
    sheet.cells.A1 = '5';
    sheet.cells.A2 = '=A1*2';
    sheet.cells.B1 = '=A2+3';

    const evaluation = evaluateSheet(sheet);

    expect(evaluation.byAddress.A2.dependsOn).toEqual(['A1']);
    expect(evaluation.byAddress.A1.dependents).toEqual(['A2']);
    expect(evaluation.dependencies.A2.dependsOn).toEqual(['A1']);
    expect(evaluation.dependencies.A1.dependents.includes('A2')).toBe(true);

    const serialized = serializeSheetContent(sheet);
    const sheetDoc = parseSheetDocString(serialized);
    const primarySheet = sheetDoc.sheets[0];

    expect(primarySheet.cells.A2?.formula).toBe('=A1*2');
    expect(primarySheet.cells.A2?.value).toBe(10);
    expect(primarySheet.cells.B1?.value).toBe(13);
    expect(primarySheet.dependencies.A2.dependsOn.includes('A1')).toBe(true);
    expect(primarySheet.dependencies.A1.dependents.includes('A2')).toBe(true);
  });

  it('extracts external page references from formulas', () => {
    const sheet = createEmptySheet(4, 4);
    sheet.cells.A1 = '=@[Sales Report](sales-1):B1 + @[Sales Report]:B2';
    sheet.cells.A2 = '=SUM(@[Ops Summary](ops-9):A1:A3)';

    const references = collectExternalReferences(sheet);

    expect(references.length).toBe(3);
    const rawMentions = references.map((ref) => ref.raw).sort();
    expect(rawMentions).toEqual([
      '@[Ops Summary](ops-9)',
      '@[Sales Report]',
      '@[Sales Report](sales-1)',
    ]);
    const salesWithId = references.find((ref) => ref.identifier === 'sales-1');
    expect(salesWithId).toBeTruthy();
    expect(salesWithId?.label).toBe('Sales Report');
  });

  it('evaluates formulas with external page references', () => {
    const mainSheet = createEmptySheet(6, 4);
    mainSheet.cells.A1 = '=@[Sales](sales-1):B1 + @[Sales](sales-1):B2';
    mainSheet.cells.A2 = '=SUM(@[Sales](sales-1):B1:B3)';
    mainSheet.cells.A3 = '=@[Budget]:C1';
    mainSheet.cells.A4 = '=IF(@[Sales](sales-1):B1>5, "ok", "bad")';
    mainSheet.cells.A5 = '=@[Missing]:A1';

    const salesSheet = createEmptySheet(5, 5);
    salesSheet.cells.B1 = '10';
    salesSheet.cells.B2 = '5';
    salesSheet.cells.B3 = '1';

    const budgetSheet = createEmptySheet(3, 3);
    budgetSheet.cells.C1 = '42';

    const resolver = (reference: ReturnType<typeof collectExternalReferences>[number]) => {
      if (reference.identifier === 'sales-1' || reference.label === 'Sales') {
        return { pageId: 'sales-1', pageTitle: 'Sales', sheet: salesSheet };
      }
      if (reference.label === 'Budget') {
        return { pageId: 'budget-1', pageTitle: 'Budget', sheet: budgetSheet };
      }
      return {
        pageId: reference.identifier ?? reference.raw,
        pageTitle: reference.label,
        error: `Referenced page "${reference.label}" is not available`,
      };
    };

    const evaluation = evaluateSheet(mainSheet, {
      pageId: 'main',
      pageTitle: 'Main Sheet',
      resolveExternalReference: resolver,
    });

    expect(getDisplay(evaluation, 'A1')).toBe('15');
    expect(getDisplay(evaluation, 'A2')).toBe('16');
    expect(getDisplay(evaluation, 'A3')).toBe('42');
    expect(getDisplay(evaluation, 'A4')).toBe('ok');
    expect(getDisplay(evaluation, 'A5')).toBe('#ERROR');
    expect(getError(evaluation, 'A5')).toBe('Referenced page "Missing" is not available');
    expect(evaluation.byAddress.A2.dependsOn.some((ref) => ref.includes('@[Sales]'))).toBe(true);
  });
});

describe('sheet sanitisation', () => {
  it('removes invalid cell keys and enforces bounds', () => {
    const dirtySheet = {
      version: 1,
      rowCount: 0,
      columnCount: -3,
      cells: {
        A1: '1',
        'Z0': '2',
        foo: '3',
      },
    } as SheetData;

    const sanitised = sanitizeSheetData(dirtySheet);
    expect(sanitised.rowCount >= 1).toBe(true);
    expect(sanitised.columnCount >= 1).toBe(true);
    expect(Object.keys(sanitised.cells)).toEqual(['A1']);
  });
});
