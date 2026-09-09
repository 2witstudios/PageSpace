import { describe, it, expect } from 'vitest';
import type { SheetData } from '@pagespace/lib/sheets/sheet';
import { buildFindMatches } from '../find';

/** Adapt a dense fixture grid to the `DisplayLookup` the cores now take. */
const lookup = (grid: string[][]) => (row: number, column: number): string => grid[row]?.[column] ?? '';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const sheet = (cells: Record<string, string>, rowCount = 2, columnCount = 2): SheetData => ({
  version: 1,
  rowCount,
  columnCount,
  cells,
});

describe('buildFindMatches', () => {
  it('returns no matches for an empty query', () => {
    assert({
      given: 'an empty query',
      should: 'return an empty match list',
      actual: buildFindMatches('', sheet({ A1: 'hello' }), lookup([['hello', '']])),
      expected: [],
    });
  });

  it('matches on the raw cell content case-insensitively', () => {
    assert({
      given: 'a query matching the raw content in a different case',
      should: 'match the cell',
      actual: buildFindMatches('HELLO', sheet({ A1: 'hello world' }), lookup([['hello world', ''], ['', '']])),
      expected: ['A1'],
    });
  });

  it('matches on the display value even when the raw differs', () => {
    assert({
      given: 'a formula cell whose display equals the query but whose raw does not',
      should: 'still match via the display value',
      actual: buildFindMatches('2', sheet({ A1: '=1+1' }), lookup([['2', ''], ['', '']])),
      expected: ['A1'],
    });
  });

  it('returns an empty list when nothing matches', () => {
    assert({
      given: 'a query present in neither raw nor display',
      should: 'return no matches',
      actual: buildFindMatches('zzz', sheet({ A1: 'abc' }), lookup([['abc', ''], ['', '']])),
      expected: [],
    });
  });

  it('treats a missing display row as an empty display value', () => {
    assert({
      given: 'a lookup that returns nothing outside the fixture grid',
      should: 'not throw and fall back to empty display strings',
      actual: buildFindMatches('abc', sheet({ A1: 'abc' }, 2, 2), lookup([])),
      expected: ['A1'],
    });
  });
});
