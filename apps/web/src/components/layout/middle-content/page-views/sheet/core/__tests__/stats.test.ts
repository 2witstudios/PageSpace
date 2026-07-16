import { describe, it, expect } from 'vitest';
import type { SheetEvaluationCell } from '@pagespace/lib/sheets/sheet';
import { computeSelectionStats } from '../stats';
import type { SelectionState } from '../selection';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const cell = (over: Partial<SheetEvaluationCell> & { address: string }): SheetEvaluationCell => ({
  raw: '',
  value: '',
  display: '',
  type: 'empty',
  dependsOn: [],
  dependents: [],
  ...over,
});

const single = (row: number, column: number): SelectionState => ({ type: 'single', cell: { row, column } });
const range = (sr: number, sc: number, er: number, ec: number): SelectionState => ({
  type: 'range',
  range: { start: { row: sr, column: sc }, end: { row: er, column: ec } },
});

describe('computeSelectionStats', () => {
  it('reports a single numeric cell', () => {
    const byAddress = { A1: cell({ address: 'A1', type: 'number', value: 5 }) };
    assert({
      given: 'a single selection over a numeric cell',
      should: 'report sum, average and counts',
      actual: computeSelectionStats(single(0, 0), byAddress),
      expected: { sum: 5, average: 5, count: 1, numericCount: 1 },
    });
  });

  it('counts non-numeric text as present but not numeric', () => {
    const byAddress = { A1: cell({ address: 'A1', type: 'string', value: 'hello' }) };
    assert({
      given: 'a single selection over a non-empty text cell',
      should: 'count it as present with no numeric stats',
      actual: computeSelectionStats(single(0, 0), byAddress),
      expected: { sum: null, average: null, count: 1, numericCount: 0 },
    });
  });

  it('ignores an empty cell entirely', () => {
    const byAddress = { A1: cell({ address: 'A1', type: 'empty', value: '' }) };
    assert({
      given: 'a single selection over an empty cell',
      should: 'report zero counts and null stats',
      actual: computeSelectionStats(single(0, 0), byAddress),
      expected: { sum: null, average: null, count: 0, numericCount: 0 },
    });
  });

  it('ignores a cell with no evaluation entry', () => {
    assert({
      given: 'a single selection over a cell with no evaluation data',
      should: 'report zero counts',
      actual: computeSelectionStats(single(2, 2), {}),
      expected: { sum: null, average: null, count: 0, numericCount: 0 },
    });
  });

  it('sums and averages a numeric range', () => {
    const byAddress = {
      A1: cell({ address: 'A1', type: 'number', value: 2 }),
      B1: cell({ address: 'B1', type: 'number', value: 4 }),
      A2: cell({ address: 'A2', type: 'number', value: 6 }),
      B2: cell({ address: 'B2', type: 'number', value: 8 }),
    };
    assert({
      given: 'a 2x2 numeric range',
      should: 'sum to 20 and average to 5',
      actual: computeSelectionStats(range(0, 0, 1, 1), byAddress),
      expected: { sum: 20, average: 5, count: 4, numericCount: 4 },
    });
  });

  it('excludes non-finite numeric values from sum/average via Number.isFinite', () => {
    const byAddress = {
      A1: cell({ address: 'A1', type: 'number', value: 10 }),
      B1: cell({ address: 'B1', type: 'number', value: Infinity }),
      A2: cell({ address: 'A2', type: 'number', value: NaN }),
    };
    assert({
      given: 'a range mixing a finite number with Infinity and NaN',
      should: 'exclude the non-finite values from sum/average but count them as present',
      actual: computeSelectionStats(range(0, 0, 1, 1), byAddress),
      expected: { sum: 10, average: 10, count: 3, numericCount: 1 },
    });
  });

  it('returns null sum and average for an all-empty range, not zero', () => {
    assert({
      given: 'a range where every cell is empty',
      should: 'return null sum and average rather than 0',
      actual: computeSelectionStats(range(0, 0, 1, 1), {}),
      expected: { sum: null, average: null, count: 0, numericCount: 0 },
    });
  });
});
