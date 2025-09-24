import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
} from '../sheet';

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
      assert.equal(encoded, expected);
      const decoded = decodeCellAddress(encoded);
      assert.equal(decoded.row, row);
      assert.equal(decoded.column, column);
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
    assert.equal(parsed.version, 3);
    assert.equal(parsed.rowCount, 7);
    assert.equal(parsed.columnCount, 4);
    assert.equal(parsed.cells.A1, '42');
    assert.equal(parsed.cells.B2, '3');
    assert.equal(parsed.cells.invalid, undefined);

    const sanitized = sanitizeSheetData(parsed);
    const serialized = serializeSheetContent(sanitized);
    assert.equal(serialized.trimStart().startsWith(SHEETDOC_MAGIC), true);

    const sheetDoc = parseSheetDocString(serialized);
    assert.equal(sheetDoc.sheets.length > 0, true);
    const primarySheet = sheetDoc.sheets[0];
    assert.equal(primarySheet.cells.A1?.value, 42);
    assert.equal(primarySheet.cells.B2?.value, 3);

    const roundTripped = parseSheetContent(serialized);
    assert.equal(roundTripped.version, 1);
    assert.equal(roundTripped.rowCount, sanitized.rowCount);
    assert.equal(roundTripped.columnCount, sanitized.columnCount);
    assert.deepEqual(roundTripped.cells, sanitized.cells);
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

    assert.equal(getDisplay(evaluation, 'A3'), '15');
    assert.equal(getDisplay(evaluation, 'B2'), 'Hello World');
    assert.equal(getDisplay(evaluation, 'B3'), '2');
    assert.equal(getDisplay(evaluation, 'C1'), '30');
    assert.equal(getDisplay(evaluation, 'C2'), '7.5');
    assert.equal(getDisplay(evaluation, 'C3'), 'small');
    assert.equal(getDisplay(evaluation, 'C4'), '7');
    assert.equal(getDisplay(evaluation, 'C5'), '5');
    assert.equal(getDisplay(evaluation, 'D1'), '15');
    assert.equal(getDisplay(evaluation, 'D2'), '5');
    assert.equal(getDisplay(evaluation, 'D3'), '3');
    assert.equal(getDisplay(evaluation, 'D4'), '5.68');
    assert.equal(getDisplay(evaluation, 'D5'), '5.5');
    assert.equal(getDisplay(evaluation, 'D6'), '5.5');
    assert.equal(getDisplay(evaluation, 'E1'), 'exact');
    assert.equal(getDisplay(evaluation, 'E2'), 'true');

    assert.equal(getError(evaluation, 'A3'), undefined);
    assert.equal(getError(evaluation, 'C1'), undefined);
  });

  it('propagates formula errors and detects circular references', () => {
    const sheet = createEmptySheet(4, 4);
    sheet.cells.A1 = '=1/0';
    sheet.cells.A2 = '=A1+1';
    sheet.cells.B1 = '=A1';
    sheet.cells.B2 = '=B2+1';

    const evaluation = evaluateSheet(sheet);

    assert.equal(getDisplay(evaluation, 'A1'), '#ERROR');
    assert.equal(getError(evaluation, 'A1'), 'Division by zero');
    assert.equal(getDisplay(evaluation, 'B1'), '#ERROR');
    assert.equal(getError(evaluation, 'B1'), 'Division by zero');
    assert.equal(getDisplay(evaluation, 'B2'), '#ERROR');
    assert.equal(getError(evaluation, 'B2'), 'Circular reference detected');
  });

  it('exposes dependency metadata and serializes SheetDoc values', () => {
    const sheet = createEmptySheet(3, 3);
    sheet.cells.A1 = '5';
    sheet.cells.A2 = '=A1*2';
    sheet.cells.B1 = '=A2+3';

    const evaluation = evaluateSheet(sheet);

    assert.deepEqual(evaluation.byAddress.A2.dependsOn, ['A1']);
    assert.deepEqual(evaluation.byAddress.A1.dependents, ['A2']);
    assert.deepEqual(evaluation.dependencies.A2.dependsOn, ['A1']);
    assert.equal(evaluation.dependencies.A1.dependents.includes('A2'), true);

    const serialized = serializeSheetContent(sheet);
    const sheetDoc = parseSheetDocString(serialized);
    const primarySheet = sheetDoc.sheets[0];

    assert.equal(primarySheet.cells.A2?.formula, '=A1*2');
    assert.equal(primarySheet.cells.A2?.value, 10);
    assert.equal(primarySheet.cells.B1?.value, 13);
    assert.equal(primarySheet.dependencies.A2.dependsOn.includes('A1'), true);
    assert.equal(primarySheet.dependencies.A1.dependents.includes('A2'), true);
  });

  it('extracts external page references from formulas', () => {
    const sheet = createEmptySheet(4, 4);
    sheet.cells.A1 = '=@[Sales Report](sales-1):B1 + @[Sales Report]:B2';
    sheet.cells.A2 = '=SUM(@[Ops Summary](ops-9):A1:A3)';

    const references = collectExternalReferences(sheet);

    assert.equal(references.length, 3);
    const rawMentions = references.map((ref) => ref.raw).sort();
    assert.deepEqual(rawMentions, [
      '@[Ops Summary](ops-9)',
      '@[Sales Report]',
      '@[Sales Report](sales-1)',
    ]);
    const salesWithId = references.find((ref) => ref.identifier === 'sales-1');
    assert.ok(salesWithId);
    assert.equal(salesWithId?.label, 'Sales Report');
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

    assert.equal(getDisplay(evaluation, 'A1'), '15');
    assert.equal(getDisplay(evaluation, 'A2'), '16');
    assert.equal(getDisplay(evaluation, 'A3'), '42');
    assert.equal(getDisplay(evaluation, 'A4'), 'ok');
    assert.equal(getDisplay(evaluation, 'A5'), '#ERROR');
    assert.equal(getError(evaluation, 'A5'), 'Referenced page "Missing" is not available');
    assert.ok(evaluation.byAddress.A2.dependsOn.some((ref) => ref.includes('@[Sales]')));
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
    assert.equal(sanitised.rowCount >= 1, true);
    assert.equal(sanitised.columnCount >= 1, true);
    assert.deepEqual(Object.keys(sanitised.cells), ['A1']);
  });
});
