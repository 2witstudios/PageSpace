/**
 * Dependency extraction keeps ranges as rectangles.
 *
 * The property under test is not "it finds the references" but "it does not
 * expand them": the evaluator's own collector turns `D1:D100000` into 100,000
 * addresses, and persisting that shape would put an O(sheet) write back into
 * every formula edit.
 */

import { describe, it, expect } from 'vitest';
import { extractFormulaDependencies, rectContains } from '../sheets/deps';

describe('extractFormulaDependencies', () => {
  it('returns nothing for a non-formula', () => {
    expect(extractFormulaDependencies('hello')).toEqual({ cells: [], ranges: [], readsExternal: false });
    expect(extractFormulaDependencies('')).toEqual({ cells: [], ranges: [], readsExternal: false });
  });

  it('collects individual cell references', () => {
    const deps = extractFormulaDependencies('=B2*C2');
    expect(deps.cells).toEqual(['B2', 'C2']);
    expect(deps.ranges).toEqual([]);
  });

  it('normalizes absolute references so $D$4 and D4 are one edge', () => {
    expect(extractFormulaDependencies('=$D$4+D4').cells).toEqual(['D4']);
  });

  it('keeps a range as one rectangle rather than expanding it', () => {
    const deps = extractFormulaDependencies('=SUM(D1:D100000)');

    // The whole point: one edge, not 100,000.
    expect(deps.ranges).toHaveLength(1);
    expect(deps.cells).toEqual([]);
    expect(deps.ranges[0]).toEqual({ rowStart: 0, rowEnd: 99999, colStart: 3, colEnd: 3 });
  });

  it('normalizes a reversed range to an ordered rectangle', () => {
    const [rect] = extractFormulaDependencies('=SUM(C10:A2)').ranges;
    expect(rect).toEqual({ rowStart: 1, rowEnd: 9, colStart: 0, colEnd: 2 });
  });

  it('finds references nested inside function arguments and arithmetic', () => {
    const deps = extractFormulaDependencies('=IF(A1>0, SUM(B1:B10) + C3, 0)');
    expect(deps.cells).toEqual(['A1', 'C3']);
    expect(deps.ranges).toEqual([{ rowStart: 0, rowEnd: 9, colStart: 1, colEnd: 1 }]);
  });

  it('returns empty rather than throwing on an unparseable formula', () => {
    // One malformed cell must not fail a whole sheet's dependency rebuild.
    expect(extractFormulaDependencies('=SUM(((')).toEqual({ cells: [], ranges: [], readsExternal: false });
  });

  it('flags a cross-page reference without trying to enumerate it', () => {
    // A change in another page is not something this page's write path
    // observes, so there is no edge to walk — only the fact that one exists.
    const deps = extractFormulaDependencies('=@[Other](p1):A1 + B2');
    expect(deps.readsExternal).toBe(true);
    expect(deps.cells).toEqual(['B2']);
  });

  it('treats an open-ended range as unsupported input, not a crash', () => {
    // `FormulaParser.parseRange` rejects non-address endpoints, so `D:D` never
    // reaches storage. Pinned so that if the parser later accepts it, this
    // test fails and the storage side gets revisited deliberately.
    expect(extractFormulaDependencies('=SUM(D:D)')).toEqual({ cells: [], ranges: [], readsExternal: false });
  });
});

describe('rectContains', () => {
  const rect = { rowStart: 2, rowEnd: 5, colStart: 1, colEnd: 3 };

  it('accepts cells inside and on the boundary', () => {
    expect(rectContains(rect, 2, 1)).toBe(true);
    expect(rectContains(rect, 5, 3)).toBe(true);
    expect(rectContains(rect, 3, 2)).toBe(true);
  });

  it('rejects cells outside any edge', () => {
    expect(rectContains(rect, 1, 2)).toBe(false);
    expect(rectContains(rect, 6, 2)).toBe(false);
    expect(rectContains(rect, 3, 0)).toBe(false);
    expect(rectContains(rect, 3, 4)).toBe(false);
  });

  it('treats a null end as open', () => {
    const open = { rowStart: 0, rowEnd: null, colStart: 3, colEnd: 3 };
    expect(rectContains(open, 999999, 3)).toBe(true);
    expect(rectContains(open, 999999, 4)).toBe(false);
  });
});
