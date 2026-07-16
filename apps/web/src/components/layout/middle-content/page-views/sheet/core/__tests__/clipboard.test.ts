import { describe, it, expect } from 'vitest';
import type { SheetData } from '@pagespace/lib/sheets/sheet';
import {
  parseClipboardData,
  buildCopyPayload,
  resolvePasteMode,
  computePasteCells,
} from '../clipboard';
import type { SelectionState } from '../selection';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const sheet = (cells: Record<string, string> = {}, rowCount = 5, columnCount = 3): SheetData => ({
  version: 1,
  rowCount,
  columnCount,
  cells,
});

const single = (row: number, column: number): SelectionState => ({ type: 'single', cell: { row, column } });
const range = (sr: number, sc: number, er: number, ec: number): SelectionState => ({
  type: 'range',
  range: { start: { row: sr, column: sc }, end: { row: er, column: ec } },
});

describe('parseClipboardData', () => {
  it('returns null for blank-lines-only input', () => {
    assert({
      given: 'a string of only blank lines',
      should: 'return null',
      actual: parseClipboardData('\n\n\n'),
      expected: null,
    });
  });

  it('returns null for an empty string', () => {
    assert({
      given: 'an empty string',
      should: 'return null',
      actual: parseClipboardData(''),
      expected: null,
    });
  });

  it('splits tab-separated rows', () => {
    assert({
      given: 'tab-separated cells across two rows',
      should: 'split on tabs',
      actual: parseClipboardData('a\tb\nc\td'),
      expected: { data: [['a', 'b'], ['c', 'd']], rows: 2, columns: 2 },
    });
  });

  it('splits comma-separated rows with trimming when no tabs present', () => {
    assert({
      given: 'comma-separated cells with surrounding whitespace',
      should: 'split on commas and trim each cell',
      actual: parseClipboardData('a, b\nc, d'),
      expected: { data: [['a', 'b'], ['c', 'd']], rows: 2, columns: 2 },
    });
  });

  it('pads ragged comma rows to the widest row', () => {
    assert({
      given: 'comma rows of differing lengths',
      should: 'pad shorter rows with empty strings',
      actual: parseClipboardData('a,b,c\nd'),
      expected: { data: [['a', 'b', 'c'], ['d', '', '']], rows: 2, columns: 3 },
    });
  });

  it('treats tab-free comma-free lines as a single column', () => {
    assert({
      given: 'plain lines without tabs or commas',
      should: 'produce one column per line',
      actual: parseClipboardData('hello\nworld'),
      expected: { data: [['hello'], ['world']], rows: 2, columns: 1 },
    });
  });
});

describe('buildCopyPayload', () => {
  const display = [
    ['1', '2', '3'],
    ['4', '5', '6'],
  ];
  const cells = { A1: '=1', B1: '2' };

  it('copies the raw formula for a single cell in formulas mode', () => {
    assert({
      given: 'a single-cell selection in formulas mode',
      should: 'copy the raw cell content',
      actual: buildCopyPayload(single(0, 0), sheet(cells), display, 'formulas').data,
      expected: '=1',
    });
  });

  it('copies the display value for a single cell in values mode', () => {
    assert({
      given: 'a single-cell selection in values mode',
      should: 'copy the evaluated display value',
      actual: buildCopyPayload(single(0, 0), sheet(cells), display, 'values').data,
      expected: '1',
    });
  });

  it('joins a range with tabs and newlines in formulas mode', () => {
    assert({
      given: 'a range selection in formulas mode',
      should: 'tab-join columns and newline-join rows of raw values',
      actual: buildCopyPayload(range(0, 0, 1, 1), sheet(cells), display, 'formulas').data,
      expected: '=1\t2\n\t',
    });
  });

  it('joins a range with tabs and newlines in values mode', () => {
    assert({
      given: 'a range selection in values mode',
      should: 'tab-join columns and newline-join rows of display values',
      actual: buildCopyPayload(range(0, 0, 1, 1), sheet(cells), display, 'values').data,
      expected: '1\t2\n4\t5',
    });
  });

  it('reports a cell count of 1 for a single selection', () => {
    assert({
      given: 'a single-cell selection',
      should: 'report cellCount 1',
      actual: buildCopyPayload(single(0, 0), sheet(cells), display, 'formulas').cellCount,
      expected: 1,
    });
  });

  it('reports the rectangle area as the cell count for a range', () => {
    assert({
      given: 'a 2x2 range selection',
      should: 'report cellCount 4',
      actual: buildCopyPayload(range(0, 0, 1, 1), sheet(cells), display, 'values').cellCount,
      expected: 4,
    });
  });
});

describe('resolvePasteMode', () => {
  it('honours an explicit values request', () => {
    assert({
      given: "an explicit 'values' request",
      should: 'return values',
      actual: resolvePasteMode('values', true, 'formulas'),
      expected: 'values',
    });
  });

  it('honours an explicit formulas request', () => {
    assert({
      given: "an explicit 'formulas' request",
      should: 'return formulas',
      actual: resolvePasteMode('formulas', false, undefined),
      expected: 'formulas',
    });
  });

  it('uses the copied mode for an internal auto paste', () => {
    assert({
      given: 'auto mode for an internal paste with a stored formulas mode',
      should: 'return the stored copied mode',
      actual: resolvePasteMode('auto', true, 'formulas'),
      expected: 'formulas',
    });
  });

  it('falls back to values for an internal auto paste with no stored mode', () => {
    assert({
      given: 'auto mode for an internal paste with no stored mode',
      should: 'default to values',
      actual: resolvePasteMode('auto', true, undefined),
      expected: 'values',
    });
  });

  it('forces values for an external auto paste', () => {
    assert({
      given: 'auto mode for an external paste',
      should: 'force values mode',
      actual: resolvePasteMode('auto', false, undefined),
      expected: 'values',
    });
  });
});

describe('computePasteCells', () => {
  const table = (data: string[][]) => ({ data, rows: data.length, columns: data[0].length });

  it('adjusts formula references for an internal formulas paste with a nonzero offset', () => {
    const result = computePasteCells({
      previous: sheet({}),
      table: table([['=A1']]),
      start: { row: 1, column: 0 },
      pasteMode: 'formulas',
      isInternalPaste: true,
      copyStart: { row: 0, column: 0 },
    });
    assert({
      given: 'an internal formulas paste one row below the copy origin',
      should: 'shift the formula reference down by one row',
      actual: result.cells.A2,
      expected: '=A2',
    });
  });

  it('does not adjust formula references when the offset is zero', () => {
    const result = computePasteCells({
      previous: sheet({}),
      table: table([['=A1']]),
      start: { row: 0, column: 0 },
      pasteMode: 'formulas',
      isInternalPaste: true,
      copyStart: { row: 0, column: 0 },
    });
    assert({
      given: 'an internal formulas paste at the copy origin',
      should: 'keep the formula reference unchanged',
      actual: result.cells.A1,
      expected: '=A1',
    });
  });

  it('skips formula values in values mode, leaving the target untouched', () => {
    const result = computePasteCells({
      previous: sheet({ A1: 'keep' }),
      table: table([['=A1']]),
      start: { row: 0, column: 0 },
      pasteMode: 'values',
      isInternalPaste: false,
    });
    assert({
      given: 'a values-mode paste of a formula string',
      should: 'not overwrite the existing target cell',
      actual: result.cells.A1,
      expected: 'keep',
    });
  });

  it('deletes the target cell when the source cell is empty', () => {
    const result = computePasteCells({
      previous: sheet({ A1: 'old' }),
      table: table([['   ']]),
      start: { row: 0, column: 0 },
      pasteMode: 'values',
      isInternalPaste: false,
    });
    assert({
      given: 'a paste whose source cell is whitespace-only',
      should: 'delete the target cell',
      actual: 'A1' in result.cells,
      expected: false,
    });
  });

  it('writes a plain non-formula value', () => {
    const result = computePasteCells({
      previous: sheet({}),
      table: table([['hello']]),
      start: { row: 0, column: 0 },
      pasteMode: 'values',
      isInternalPaste: false,
    });
    assert({
      given: 'a plain text paste value',
      should: 'write it to the target cell',
      actual: result.cells.A1,
      expected: 'hello',
    });
  });

  it('expands the grid when the paste exceeds the current bounds', () => {
    const result = computePasteCells({
      previous: sheet({}, 2, 2),
      table: table([['a', 'b', 'c'], ['d', 'e', 'f']]),
      start: { row: 1, column: 1 },
      pasteMode: 'values',
      isInternalPaste: false,
    });
    assert({
      given: 'a paste that runs past the current row/column counts',
      should: 'expand rowCount and columnCount to fit',
      actual: { rowCount: result.rowCount, columnCount: result.columnCount },
      expected: { rowCount: 3, columnCount: 4 },
    });
  });

  it('bumps the version and does not mutate the previous sheet', () => {
    const previous = sheet({ A1: 'old' });
    const result = computePasteCells({
      previous,
      table: table([['new']]),
      start: { row: 0, column: 0 },
      pasteMode: 'values',
      isInternalPaste: false,
    });
    assert({
      given: 'any paste mutation',
      should: 'bump version and leave the previous sheet unchanged',
      actual: { version: result.version, previousA1: previous.cells.A1 },
      expected: { version: 2, previousA1: 'old' },
    });
  });
});
