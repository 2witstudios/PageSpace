/**
 * `evaluateAddresses` must agree with a full `evaluateSheet` pass.
 *
 * The row store recomputes a dependency closure instead of the grid, so the
 * targeted evaluator becomes the thing that decides what a cell is worth. If it
 * can disagree with the full pass — on values, on errors, or on cycles — then a
 * sheet's contents depend on which write path last touched it.
 */

import { describe, it, expect } from 'vitest';
import { evaluateSheet, evaluateAddresses } from '../sheets/evaluation';
import type { SheetData } from '../sheets/types';

const sheet: SheetData = {
  version: 1,
  rowCount: 6,
  columnCount: 4,
  cells: {
    A1: '10',
    A2: '20',
    A3: '30',
    B1: '=A1*2',
    B2: '=B1+A2',
    C1: '=SUM(A1:A3)',
    D1: 'text',
    D2: '=D1',
  },
};

describe('evaluateAddresses', () => {
  it('agrees with a full sheet pass on every requested cell', () => {
    const full = evaluateSheet(sheet);
    const targeted = evaluateAddresses(sheet, ['B1', 'B2', 'C1', 'D2']);

    for (const address of ['B1', 'B2', 'C1', 'D2']) {
      expect(targeted[address].value, address).toEqual(full.byAddress[address].value);
      expect(targeted[address].display, address).toEqual(full.byAddress[address].display);
      expect(targeted[address].error, address).toEqual(full.byAddress[address].error);
    }
  });

  it('resolves chained formulas through cells it was not asked for', () => {
    // B2 depends on B1, which is not in the requested set. Reading an input
    // must still work, or a closure would have to include every ancestor.
    expect(evaluateAddresses(sheet, ['B2'])['B2'].value).toBe(40);
  });

  it('evaluates a range without being asked for the range members', () => {
    expect(evaluateAddresses(sheet, ['C1'])['C1'].value).toBe(60);
  });

  it('returns only what was asked for', () => {
    expect(Object.keys(evaluateAddresses(sheet, ['B1']))).toEqual(['B1']);
  });

  it('normalizes lower-case addresses', () => {
    expect(evaluateAddresses(sheet, ['b1'])['B1'].value).toBe(20);
  });

  it('detects a cycle the same way a full pass does', () => {
    const cyclic: SheetData = {
      version: 1,
      rowCount: 3,
      columnCount: 2,
      cells: { A1: '=B1', B1: '=A1' },
    };

    const full = evaluateSheet(cyclic);
    const targeted = evaluateAddresses(cyclic, ['A1']);

    expect(targeted['A1'].error).toBe(full.byAddress['A1'].error);
    expect(targeted['A1'].display).toBe(full.byAddress['A1'].display);

    // The contract both paths share: a cycle surfaces as a flagged error, not
    // as a plausible-looking value. `#CYCLE` is only the inner sentinel the
    // recursion returns; the cell the caller asked about reports `#ERROR`.
    expect(targeted['A1'].error).toBe('Circular reference detected');
    expect(targeted['A1'].display).toBe('#ERROR');
  });

  it('reports an empty cell as empty rather than throwing', () => {
    expect(evaluateAddresses(sheet, ['Z9'])['Z9'].type).toBe('empty');
  });

  it('does NOT produce usable dependency edges', () => {
    // Pinned as a limitation, not an accident. `evaluateSheet` fills these in
    // with a post-pass over the whole grid — the work this function skips — so
    // nothing here can know which cells outside the closure point into it.
    // Persisted edges come from `extractFormulaDependencies`; a caller that
    // reached for these instead would silently write empty dependents.
    const full = evaluateSheet(sheet);
    expect(full.byAddress['A1'].dependents).toContain('B1');
    expect(evaluateAddresses(sheet, ['A1'])['A1'].dependents).toEqual([]);
  });
});
