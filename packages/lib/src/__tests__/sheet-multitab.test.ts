import { describe, it, expect } from 'vitest';
import {
  createEmptySheet,
  parseSheetContent,
  parseSheetDocString,
  serializeSheetContent,
  setCellFormats,
  setColumnFormat,
  type SheetData,
} from '../sheets/sheet';

/**
 * The editor renders only the first tab. Before this, everything after it was
 * dropped on load and never written back, so opening a three-tab workbook and
 * typing one character silently deleted two tabs.
 *
 * Full multi-tab editing is a later change; the guarantee here is narrower and
 * non-negotiable: a load/save cycle must not lose data.
 */

const multiTabDocument = [
  '#%PAGESPACE_SHEETDOC v1',
  '',
  '[[sheets]]',
  'name = "First"',
  'order = 0',
  '',
  '[sheets.meta]',
  'row_count = 20',
  'column_count = 10',
  '',
  '[sheets.cells.A1]',
  'value = "first tab"',
  'type = "string"',
  '',
  '[[sheets]]',
  'name = "Second"',
  'order = 1',
  '',
  '[sheets.meta]',
  'row_count = 30',
  'column_count = 12',
  '',
  '[sheets.cells.B2]',
  'value = 42',
  'type = "number"',
  '',
  '[[sheets]]',
  'name = "Third"',
  'order = 2',
  '',
  '[sheets.meta]',
  'row_count = 8',
  'column_count = 4',
  '',
  '[sheets.cells.C3]',
  'formula = "=1+1"',
  'value = 2',
  'type = "number"',
  '',
].join('\n');

describe('multi-tab documents', () => {
  it('loads the first tab as the active sheet', () => {
    const sheet = parseSheetContent(multiTabDocument);

    expect(sheet.cells.A1).toBe('first tab');
    expect(sheet.sheetName).toBe('First');
    expect(sheet.rowCount).toBe(20);
  });

  it('carries the remaining tabs alongside', () => {
    const sheet = parseSheetContent(multiTabDocument);

    expect(sheet.extraSheets).toHaveLength(2);
    expect(sheet.extraSheets?.map((tab) => tab.name)).toEqual(['Second', 'Third']);
  });

  it('still has three tabs after a save', () => {
    const sheet = parseSheetContent(multiTabDocument);
    const doc = parseSheetDocString(serializeSheetContent(sheet));

    expect(doc.sheets).toHaveLength(3);
    expect(doc.sheets.map((tab) => tab.name)).toEqual(['First', 'Second', 'Third']);
  });

  it('leaves the other tabs byte-identical when the first is edited', () => {
    const sheet = parseSheetContent(multiTabDocument);
    const before = parseSheetDocString(multiTabDocument);

    let edited: SheetData = { ...sheet, cells: { ...sheet.cells, A1: 'edited' } };
    edited = setCellFormats(edited, ['A1'], { bold: true });

    const after = parseSheetDocString(serializeSheetContent(edited));

    expect(after.sheets[1]).toEqual(before.sheets[1]);
    expect(after.sheets[2]).toEqual(before.sheets[2]);
    expect(after.sheets[0].cells.A1?.value).toBe('edited');
  });

  it('survives repeated load/save cycles without drift', () => {
    let content = multiTabDocument;
    for (let cycle = 0; cycle < 3; cycle++) {
      content = serializeSheetContent(parseSheetContent(content));
    }

    const doc = parseSheetDocString(content);
    expect(doc.sheets.map((tab) => tab.name)).toEqual(['First', 'Second', 'Third']);
    expect(doc.sheets[1].cells.B2?.value).toBe(42);
    expect(doc.sheets[2].cells.C3?.formula).toBe('=1+1');
  });

  it('preserves the sheet name of a single-tab document', () => {
    const named = serializeSheetContent(createEmptySheet(), { sheetName: 'Budget' });
    const sheet = parseSheetContent(named);

    expect(sheet.sheetName).toBe('Budget');
    expect(parseSheetDocString(serializeSheetContent(sheet)).sheets[0].name).toBe('Budget');
  });

  it('preserves named ranges it does not understand', () => {
    // Nothing resolves named ranges yet, but a save must not delete content
    // written by a newer build or by hand.
    const withRange = [
      '#%PAGESPACE_SHEETDOC v1',
      '',
      '[[sheets]]',
      'name = "S"',
      'order = 0',
      '',
      '[sheets.meta]',
      'row_count = 5',
      'column_count = 5',
      '',
      '[sheets.cells.A1]',
      'value = 1',
      'type = "number"',
      '',
      '[sheets.ranges.myRange]',
      'ref = "A1:B2"',
      '',
    ].join('\n');

    const doc = parseSheetDocString(serializeSheetContent(parseSheetContent(withRange)));
    expect(doc.sheets[0].ranges.myRange).toEqual({ ref: 'A1:B2' });
  });

  it('keeps internal layout keys out of the user-visible ranges', () => {
    let sheet = createEmptySheet();
    sheet.cells.A1 = '1';
    sheet = setColumnFormat(sheet, 0, { align: 'right' });

    const restored = parseSheetContent(serializeSheetContent(sheet));

    // `__columnFormats` is an implementation detail of where column defaults
    // are stored; it must not resurface as if the user had defined a range.
    expect(restored.ranges).toBeUndefined();
    expect(restored.columnFormats).toEqual({ A: { align: 'right' } });
  });

  it('adds no extra tabs to an ordinary single-tab document', () => {
    const sheet = createEmptySheet();
    sheet.cells.A1 = 'solo';

    const doc = parseSheetDocString(serializeSheetContent(sheet));
    expect(doc.sheets).toHaveLength(1);
    expect(parseSheetContent(serializeSheetContent(sheet)).extraSheets).toBeUndefined();
  });
});
