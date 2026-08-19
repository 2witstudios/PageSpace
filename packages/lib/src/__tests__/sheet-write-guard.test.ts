import { describe, it, expect } from 'vitest';
import {
  createEmptySheet,
  parseSheetContent,
  parseSheetContentSafe,
  serializeSheetContent,
  updateSheetCells,
} from '../sheets/sheet';

/**
 * Every server-side write path follows the same shape:
 *
 *   parse existing content -> updateSheetCells -> serialize -> store
 *
 * If the parse silently yields an empty sheet for content it merely failed to
 * read, that pipeline replaces the user's entire spreadsheet with whatever the
 * caller happened to be writing. This suite pins the difference between the
 * two parse functions so the guard cannot be quietly removed from a caller.
 */

const unreadableContent = [
  '#%PAGESPACE_SHEETDOC v1',
  '',
  '[[sheets]]',
  'name = "Sheet1"',
  'order = 0',
  '',
  '[sheets.meta]',
  'row_count = 20',
  'column_count = 10',
  '',
  '[sheets.cells.A1]',
  'value = "this line never closes',
  '',
].join('\n');

describe('write-path guard', () => {
  it('the unsafe parse turns unreadable content into an empty sheet', () => {
    // This is the trap every write path has to avoid.
    const sheet = parseSheetContent(unreadableContent);
    expect(Object.keys(sheet.cells)).toHaveLength(0);
  });

  it('the safe parse reports the failure instead', () => {
    const result = parseSheetContentSafe(unreadableContent);
    expect(result.ok).toBe(false);
  });

  it('appending a row to unreadable content would destroy the sheet', () => {
    // Demonstrates the concrete data loss: a public form submission appending
    // one row ends up storing a document that contains only that row.
    const sheet = parseSheetContent(unreadableContent);
    const withRow = updateSheetCells(sheet, [{ address: 'A2', value: 'submitted' }]);
    const stored = parseSheetContent(serializeSheetContent(withRow));

    expect(Object.keys(stored.cells)).toEqual(['A2']);
  });

  it('a guarded caller stops before writing anything', () => {
    const parsed = parseSheetContentSafe(unreadableContent);

    // The shape every write path uses: bail out rather than continue.
    if (parsed.ok) {
      throw new Error('expected the guard to reject unreadable content');
    }
    expect(parsed.reason).toBe('toml');
  });

  it('readable content still flows through the guard untouched', () => {
    const sheet = createEmptySheet();
    sheet.cells.A1 = 'existing';
    const content = serializeSheetContent(sheet);

    const parsed = parseSheetContentSafe(content);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const withRow = updateSheetCells(parsed.sheet, [{ address: 'A2', value: 'submitted' }]);
    const stored = parseSheetContent(serializeSheetContent(withRow));

    expect(stored.cells.A1).toBe('existing');
    expect(stored.cells.A2).toBe('submitted');
  });
});
