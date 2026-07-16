import { describe, it, expect } from 'vitest';
import type { SheetData } from '@pagespace/lib/sheets/sheet';
import {
  applyCellWrite,
  applyCellDelete,
  initialEditValueForKey,
  isPrintableKey,
  addRow,
  addColumn,
} from '../cell-ops';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const sheet = (cells: Record<string, string> = {}, rowCount = 3, columnCount = 3): SheetData => ({
  version: 1,
  rowCount,
  columnCount,
  cells,
});

describe('applyCellWrite', () => {
  it('stores a non-empty value and bumps the version', () => {
    const result = applyCellWrite(sheet({}), 'A1', '42');
    assert({
      given: 'a non-empty write',
      should: 'store the value and bump the version',
      actual: { A1: result.cells.A1, version: result.version },
      expected: { A1: '42', version: 2 },
    });
  });

  it('stores the raw (untrimmed) value when it has non-whitespace content', () => {
    const result = applyCellWrite(sheet({}), 'A1', '  hi ');
    assert({
      given: 'a value padded with whitespace but not blank',
      should: 'store the raw value verbatim',
      actual: result.cells.A1,
      expected: '  hi ',
    });
  });

  it('deletes the cell for a whitespace-only write', () => {
    const result = applyCellWrite(sheet({ A1: 'old' }), 'A1', '   ');
    assert({
      given: 'a whitespace-only write over an existing cell',
      should: 'delete the cell rather than store whitespace',
      actual: 'A1' in result.cells,
      expected: false,
    });
  });

  it('does not mutate the previous sheet', () => {
    const previous = sheet({ A1: 'old' });
    applyCellWrite(previous, 'A1', 'new');
    assert({
      given: 'the previous sheet after a write',
      should: 'remain unchanged',
      actual: previous.cells.A1,
      expected: 'old',
    });
  });
});

describe('applyCellDelete', () => {
  it('removes the target cell and bumps the version', () => {
    const result = applyCellDelete(sheet({ A1: 'x', B2: 'y' }), 'A1');
    assert({
      given: 'a delete of an existing cell',
      should: 'remove it, keep others, and bump the version',
      actual: { hasA1: 'A1' in result.cells, B2: result.cells.B2, version: result.version },
      expected: { hasA1: false, B2: 'y', version: 2 },
    });
  });

  it('does not mutate the previous sheet', () => {
    const previous = sheet({ A1: 'x' });
    applyCellDelete(previous, 'A1');
    assert({
      given: 'the previous sheet after a delete',
      should: 'remain unchanged',
      actual: previous.cells.A1,
      expected: 'x',
    });
  });
});

describe('isPrintableKey', () => {
  it('accepts a single printable ASCII character', () => {
    assert({ given: "the key 'a'", should: 'be printable', actual: isPrintableKey('a'), expected: true });
  });

  it('accepts F2', () => {
    assert({ given: "the key 'F2'", should: 'be printable (edit trigger)', actual: isPrintableKey('F2'), expected: true });
  });

  it('rejects a multi-character control key', () => {
    assert({ given: "the key 'Enter'", should: 'not be printable', actual: isPrintableKey('Enter'), expected: false });
  });

  it('rejects a single non-ASCII character', () => {
    assert({ given: "the key 'é'", should: 'not be printable', actual: isPrintableKey('é'), expected: false });
  });
});

describe('initialEditValueForKey', () => {
  it('keeps the current value when no key is given', () => {
    assert({
      given: 'no key (e.g. double-click edit)',
      should: 'return the current cell value',
      actual: initialEditValueForKey('=SUM(A1:A2)', undefined),
      expected: '=SUM(A1:A2)',
    });
  });

  it('keeps the current value for F2', () => {
    assert({
      given: 'the F2 key',
      should: 'edit starting from the current value',
      actual: initialEditValueForKey('current', 'F2'),
      expected: 'current',
    });
  });

  it('replaces the value with a typed printable character', () => {
    assert({
      given: 'a single printable character keystroke',
      should: 'start the edit with just that character',
      actual: initialEditValueForKey('old', 'x'),
      expected: 'x',
    });
  });

  it('keeps the current value for a non-printable multi-char key', () => {
    assert({
      given: 'a non-printable key that is not F2',
      should: 'return the current value unchanged',
      actual: initialEditValueForKey('old', 'ArrowLeft'),
      expected: 'old',
    });
  });
});

describe('addRow', () => {
  it('increments rowCount and bumps the version without mutating the previous', () => {
    const previous = sheet({}, 3, 3);
    const result = addRow(previous);
    assert({
      given: 'a sheet with 3 rows',
      should: 'return 4 rows, bumped version, previous untouched',
      actual: { rowCount: result.rowCount, version: result.version, prevRows: previous.rowCount },
      expected: { rowCount: 4, version: 2, prevRows: 3 },
    });
  });
});

describe('addColumn', () => {
  it('increments columnCount and bumps the version without mutating the previous', () => {
    const previous = sheet({}, 3, 3);
    const result = addColumn(previous);
    assert({
      given: 'a sheet with 3 columns',
      should: 'return 4 columns, bumped version, previous untouched',
      actual: { columnCount: result.columnCount, version: result.version, prevCols: previous.columnCount },
      expected: { columnCount: 4, version: 2, prevCols: 3 },
    });
  });
});
