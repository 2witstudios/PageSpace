import { describe, it, expect } from 'vitest';
import {
  createEmptySheet,
  encodeCellAddress,
  evaluateSheet,
  evaluateSheetSparse,
  setCellFormats,
  sparseDisplayAt,
  type SheetData,
} from '../sheets/sheet';

/**
 * `evaluateSheetSparse` exists so the grid does not allocate an object per grid
 * position on every keystroke. It is only safe to use if it agrees with the
 * dense evaluator everywhere a cell actually exists — this file is that gate.
 *
 * The two are separate implementations on purpose: the dense form's output
 * reaches the exports, the published page, and the persisted dependency table,
 * so it is not refactored underneath them. That makes an equivalence test the
 * thing standing between them and silent drift.
 */

const sheetWith = (cells: Record<string, string>, rowCount = 12, columnCount = 8): SheetData => {
  const sheet = createEmptySheet();
  sheet.rowCount = rowCount;
  sheet.columnCount = columnCount;
  Object.assign(sheet.cells, cells);
  return sheet;
};

const FIXTURES: Array<{ name: string; sheet: SheetData }> = [
  { name: 'empty', sheet: createEmptySheet() },
  { name: 'plain values', sheet: sheetWith({ A1: 'text', B1: '42', C1: 'TRUE' }) },
  {
    name: 'formula chain',
    sheet: sheetWith({ A1: '1', A2: '2', A3: '=A1+A2', A4: '=A3*2', A5: '=SUM(A1:A4)' }),
  },
  { name: 'cycle', sheet: sheetWith({ A1: '=B1', B1: '=A1' }) },
  { name: 'self reference', sheet: sheetWith({ A1: '=A1+1' }) },
  { name: 'error cell', sheet: sheetWith({ A1: '=1/0', B1: '=NOSUCHFUNC()', C1: '=A1+1' }) },
  {
    name: 'formula depending on empty cells',
    sheet: sheetWith({ A1: '=Z9', B1: '=SUM(D1:D9)', C1: '=D5&"x"' }),
  },
  {
    name: 'sparse cells far apart',
    sheet: sheetWith({ A1: '1', H12: '=A1*3' }, 12, 8),
  },
  {
    name: 'formatted numbers',
    sheet: setCellFormats(sheetWith({ A1: '1234.5', A2: '0.15' }), ['A1', 'A2'], {
      number: { kind: 'currency', currency: 'USD', decimals: 2 },
    }),
  },
  {
    name: 'comparison and concatenation operators',
    sheet: setCellFormats(sheetWith({ A1: '1000', B1: '=A1&" total"', C1: '=A1=1000' }), ['A1'], {
      number: { kind: 'currency', currency: 'USD' },
    }),
  },
];

describe.each(FIXTURES)('sparse evaluation matches dense: $name', ({ sheet }) => {
  const dense = evaluateSheet(sheet);
  const sparse = evaluateSheetSparse(sheet);

  it('produces an identical cell for every address that exists', () => {
    for (const address of Object.keys(sheet.cells)) {
      expect(sparse.byAddress[address.toUpperCase()]).toEqual(
        dense.byAddress[address.toUpperCase()],
      );
    }
  });

  it('reports the same display text at every grid position', () => {
    for (let row = 0; row < sheet.rowCount; row++) {
      for (let column = 0; column < sheet.columnCount; column++) {
        expect(sparseDisplayAt(sparse, row, column)).toBe(dense.display[row][column]);
      }
    }
  });

  it('agrees on which positions carry an error', () => {
    for (let row = 0; row < sheet.rowCount; row++) {
      for (let column = 0; column < sheet.columnCount; column++) {
        const address = encodeCellAddress(row, column);
        expect(sparse.byAddress[address]?.error ?? null).toBe(dense.errors[row][column]);
      }
    }
  });

  it('agrees on the dependency records of the cells that exist', () => {
    for (const address of Object.keys(sheet.cells)) {
      const key = address.toUpperCase();
      expect(sparse.dependencies[key]).toEqual(dense.dependencies[key]);
    }
  });
});

describe('sparse evaluation', () => {
  it('allocates per existing cell, not per grid position', () => {
    // The whole point: a 10,000 × 60 sheet holding three values must not
    // produce 600,000 entries.
    const sheet = sheetWith({ A1: '1', B2: '2', C3: '=A1+B2' }, 10_000, 60);
    expect(Object.keys(evaluateSheetSparse(sheet).byAddress)).toHaveLength(3);
  });

  it('leaves an empty cell absent rather than storing an empty record', () => {
    const sparse = evaluateSheetSparse(sheetWith({ A1: '1' }));
    expect(sparse.byAddress.B5).toBeUndefined();
    expect(sparseDisplayAt(sparse, 4, 1)).toBe('');
  });

  it('ignores a key that is not an A1 address, as the dense walk does', () => {
    // `cells` is a plain map, so it can hold junk. The dense evaluator never
    // sees such a key because it enumerates grid positions; the sparse one
    // enumerates keys, so it has to skip them explicitly or it would evaluate
    // an address that does not exist.
    const sheet = createEmptySheet();
    sheet.cells['not-an-address'] = '5';
    const sparse = evaluateSheetSparse(sheet);
    expect(Object.keys(sparse.byAddress)).toHaveLength(0);
  });

  it('matches dense on a lower-case key, which neither evaluator reads', () => {
    // Documented rather than fixed here: `sanitizeSheetData` does not upper-case
    // cell keys, so a lower-case address written by hand or through the API is
    // invisible to BOTH evaluators. That is pre-existing engine behaviour; the
    // guarantee this file makes is only that the two agree about it.
    const sheet = createEmptySheet();
    sheet.cells.a1 = '5';
    expect(evaluateSheetSparse(sheet).byAddress.A1?.display).toBe(
      evaluateSheet(sheet).byAddress.A1?.display,
    );
    expect(evaluateSheet(sheet).byAddress.A1?.display).toBe('');
  });

  it('still links dependents for a cell that others reference', () => {
    const sparse = evaluateSheetSparse(sheetWith({ A1: '1', B1: '=A1', C1: '=A1*2' }));
    expect(sparse.byAddress.A1.dependents).toEqual(['B1', 'C1']);
  });
});
