import { describe, it, expect } from 'vitest';
import type { SheetData } from '@pagespace/lib/sheets/sheet';
import {
  clampSelection,
  clampRange,
  getPrimaryCell,
  isCellInSelection,
  getSelectionAddress,
  getColumnLabel,
  nextSelectionForKey,
  type GridSelection,
  type SelectionState,
} from '../selection';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const sheet = (rowCount = 5, columnCount = 3): SheetData => ({
  version: 1,
  rowCount,
  columnCount,
  cells: {},
});

const single = (row: number, column: number): SelectionState => ({ type: 'single', cell: { row, column } });
const range = (start: GridSelection, end: GridSelection): SelectionState => ({ type: 'range', range: { start, end } });

describe('clampSelection', () => {
  it('clamps a below-bounds cell up to 0,0', () => {
    assert({
      given: 'a selection with negative row and column',
      should: 'clamp both to 0',
      actual: clampSelection({ row: -3, column: -1 }, sheet()),
      expected: { row: 0, column: 0 },
    });
  });

  it('clamps an above-bounds cell down to the last row/column', () => {
    assert({
      given: 'a selection beyond the grid',
      should: 'clamp to rowCount-1 and columnCount-1',
      actual: clampSelection({ row: 99, column: 99 }, sheet(5, 3)),
      expected: { row: 4, column: 2 },
    });
  });

  it('leaves an in-bounds cell unchanged', () => {
    assert({
      given: 'a selection inside the grid',
      should: 'return the same coordinates',
      actual: clampSelection({ row: 2, column: 1 }, sheet()),
      expected: { row: 2, column: 1 },
    });
  });

  it('clamps to 0 when the grid is empty', () => {
    assert({
      given: 'a zero-sized grid',
      should: 'clamp to 0,0',
      actual: clampSelection({ row: 4, column: 4 }, sheet(0, 0)),
      expected: { row: 0, column: 0 },
    });
  });
});

describe('clampRange', () => {
  it('clamps both endpoints of the range', () => {
    assert({
      given: 'a range with out-of-bounds start and end',
      should: 'clamp start and end independently',
      actual: clampRange({ start: { row: -1, column: -1 }, end: { row: 99, column: 99 } }, sheet(5, 3)),
      expected: { start: { row: 0, column: 0 }, end: { row: 4, column: 2 } },
    });
  });
});

describe('getPrimaryCell', () => {
  it('returns the cell for a single selection', () => {
    assert({
      given: 'a single-cell selection',
      should: 'return that cell',
      actual: getPrimaryCell(single(2, 1)),
      expected: { row: 2, column: 1 },
    });
  });

  it('returns the range start for a range selection', () => {
    assert({
      given: 'a range selection',
      should: 'return the range start',
      actual: getPrimaryCell(range({ row: 1, column: 1 }, { row: 3, column: 2 })),
      expected: { row: 1, column: 1 },
    });
  });
});

describe('isCellInSelection', () => {
  it('matches the selected cell for a single selection', () => {
    assert({
      given: 'a single selection at the queried cell',
      should: 'return true',
      actual: isCellInSelection(2, 1, single(2, 1)),
      expected: true,
    });
  });

  it('rejects a non-matching cell for a single selection', () => {
    assert({
      given: 'a single selection at a different cell',
      should: 'return false',
      actual: isCellInSelection(0, 0, single(2, 1)),
      expected: false,
    });
  });

  it('includes a cell inside a range regardless of endpoint order', () => {
    assert({
      given: 'a range whose start is below-right of its end',
      should: 'still include an interior cell (min/max normalized)',
      actual: isCellInSelection(1, 1, range({ row: 3, column: 2 }, { row: 0, column: 0 })),
      expected: true,
    });
  });

  it('excludes a cell outside the range', () => {
    assert({
      given: 'a cell outside the range',
      should: 'return false',
      actual: isCellInSelection(4, 2, range({ row: 0, column: 0 }, { row: 1, column: 1 })),
      expected: false,
    });
  });
});

describe('getSelectionAddress', () => {
  it('returns a single address for a single selection', () => {
    assert({
      given: 'a single selection at row 0 column 0',
      should: 'return A1',
      actual: getSelectionAddress(single(0, 0)),
      expected: 'A1',
    });
  });

  it('collapses a range whose start equals its end', () => {
    assert({
      given: 'a range with identical start and end',
      should: 'return a single address, not a range',
      actual: getSelectionAddress(range({ row: 0, column: 0 }, { row: 0, column: 0 })),
      expected: 'A1',
    });
  });

  it('returns a colon range for a genuine range', () => {
    assert({
      given: 'a range spanning two cells',
      should: 'return start:end',
      actual: getSelectionAddress(range({ row: 0, column: 0 }, { row: 1, column: 1 })),
      expected: 'A1:B2',
    });
  });
});

describe('getColumnLabel', () => {
  it('returns the letter label with digits stripped', () => {
    assert({
      given: 'column index 0',
      should: 'return A',
      actual: getColumnLabel(0),
      expected: 'A',
    });
  });
});

describe('nextSelectionForKey', () => {
  const s = sheet(5, 3); // rows 0..4, cols 0..2

  it('moves up and clamps at the top edge', () => {
    assert({
      given: 'ArrowUp at row 0',
      should: 'clamp at row 0 rather than move',
      actual: nextSelectionForKey({ key: 'ArrowUp', shiftKey: false, isReadOnly: false }, { row: 0, column: 1 }, s),
      expected: { row: 0, column: 1 },
    });
  });

  it('moves up when not at the top', () => {
    assert({
      given: 'ArrowUp at row 2',
      should: 'move to row 1',
      actual: nextSelectionForKey({ key: 'ArrowUp', shiftKey: false, isReadOnly: false }, { row: 2, column: 1 }, s),
      expected: { row: 1, column: 1 },
    });
  });

  it('moves down and clamps at the bottom edge', () => {
    assert({
      given: 'ArrowDown at the last row',
      should: 'clamp at the last row',
      actual: nextSelectionForKey({ key: 'ArrowDown', shiftKey: false, isReadOnly: false }, { row: 4, column: 1 }, s),
      expected: { row: 4, column: 1 },
    });
  });

  it('moves down when not at the bottom', () => {
    assert({
      given: 'ArrowDown at row 1',
      should: 'move to row 2',
      actual: nextSelectionForKey({ key: 'ArrowDown', shiftKey: false, isReadOnly: false }, { row: 1, column: 1 }, s),
      expected: { row: 2, column: 1 },
    });
  });

  it('moves left and clamps at the left edge', () => {
    assert({
      given: 'ArrowLeft at column 0',
      should: 'clamp at column 0',
      actual: nextSelectionForKey({ key: 'ArrowLeft', shiftKey: false, isReadOnly: false }, { row: 1, column: 0 }, s),
      expected: { row: 1, column: 0 },
    });
  });

  it('moves left when not at the left edge', () => {
    assert({
      given: 'ArrowLeft at column 2',
      should: 'move to column 1',
      actual: nextSelectionForKey({ key: 'ArrowLeft', shiftKey: false, isReadOnly: false }, { row: 1, column: 2 }, s),
      expected: { row: 1, column: 1 },
    });
  });

  it('moves right and clamps at the right edge', () => {
    assert({
      given: 'ArrowRight at the last column',
      should: 'clamp at the last column',
      actual: nextSelectionForKey({ key: 'ArrowRight', shiftKey: false, isReadOnly: false }, { row: 1, column: 2 }, s),
      expected: { row: 1, column: 2 },
    });
  });

  it('moves right when not at the right edge', () => {
    assert({
      given: 'ArrowRight at column 0',
      should: 'move to column 1',
      actual: nextSelectionForKey({ key: 'ArrowRight', shiftKey: false, isReadOnly: false }, { row: 1, column: 0 }, s),
      expected: { row: 1, column: 1 },
    });
  });

  it('advances Tab within a row', () => {
    assert({
      given: 'Tab not at the last column',
      should: 'move one column right',
      actual: nextSelectionForKey({ key: 'Tab', shiftKey: false, isReadOnly: false }, { row: 1, column: 0 }, s),
      expected: { row: 1, column: 1 },
    });
  });

  it('wraps Tab at the last column to the next row column 0', () => {
    assert({
      given: 'Tab at the last column',
      should: 'wrap to next row column 0',
      actual: nextSelectionForKey({ key: 'Tab', shiftKey: false, isReadOnly: false }, { row: 1, column: 2 }, s),
      expected: { row: 2, column: 0 },
    });
  });

  it('does not advance Tab past the last cell of the grid', () => {
    assert({
      given: 'Tab at the last cell',
      should: 'stay on the last row (wrap column to 0, clamp row)',
      actual: nextSelectionForKey({ key: 'Tab', shiftKey: false, isReadOnly: false }, { row: 4, column: 2 }, s),
      expected: { row: 4, column: 0 },
    });
  });

  it('moves Shift+Tab within a row', () => {
    assert({
      given: 'Shift+Tab not at column 0',
      should: 'move one column left',
      actual: nextSelectionForKey({ key: 'Tab', shiftKey: true, isReadOnly: false }, { row: 1, column: 2 }, s),
      expected: { row: 1, column: 1 },
    });
  });

  it('wraps Shift+Tab at column 0 to the previous row last column', () => {
    assert({
      given: 'Shift+Tab at column 0 of a non-first row',
      should: "wrap to previous row's last column",
      actual: nextSelectionForKey({ key: 'Tab', shiftKey: true, isReadOnly: false }, { row: 2, column: 0 }, s),
      expected: { row: 1, column: 2 },
    });
  });

  it('keeps Shift+Tab at 0,0 in place', () => {
    assert({
      given: 'Shift+Tab at 0,0',
      should: 'stay at 0,0',
      actual: nextSelectionForKey({ key: 'Tab', shiftKey: true, isReadOnly: false }, { row: 0, column: 0 }, s),
      expected: { row: 0, column: 0 },
    });
  });

  it('moves Enter down a row', () => {
    assert({
      given: 'Enter not at the last row',
      should: 'move down a row',
      actual: nextSelectionForKey({ key: 'Enter', shiftKey: false, isReadOnly: false }, { row: 1, column: 1 }, s),
      expected: { row: 2, column: 1 },
    });
  });

  it('moves Shift+Enter up a row', () => {
    assert({
      given: 'Shift+Enter not at the first row',
      should: 'move up a row',
      actual: nextSelectionForKey({ key: 'Enter', shiftKey: true, isReadOnly: false }, { row: 2, column: 1 }, s),
      expected: { row: 1, column: 1 },
    });
  });

  it('does not move on Enter when read-only', () => {
    assert({
      given: 'Enter while read-only',
      should: 'stay on the current cell',
      actual: nextSelectionForKey({ key: 'Enter', shiftKey: false, isReadOnly: true }, { row: 1, column: 1 }, s),
      expected: { row: 1, column: 1 },
    });
  });

  it('returns null for a non-navigation key', () => {
    assert({
      given: 'a key that is not an arrow, Tab, or Enter',
      should: 'return null (no navigation)',
      actual: nextSelectionForKey({ key: 'a', shiftKey: false, isReadOnly: false }, { row: 1, column: 1 }, s),
      expected: null,
    });
  });
});
