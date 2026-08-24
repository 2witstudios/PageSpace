import { describe, it, expect } from 'vitest';
import {
  addressesOfRange,
  evaluateConditionalFormats,
  matchesCondition,
  mixColors,
  rangeAnchor,
  type ConditionalContext,
  type ConditionalRule,
} from '../sheets/conditional';
import type { SheetPrimitive } from '../sheets/sheet';

/** A context backed by a plain map, so rules are testable without an engine. */
const contextOf = (
  values: Record<string, SheetPrimitive>,
  options: { errors?: string[]; formula?: (formula: string) => SheetPrimitive } = {}
): ConditionalContext => ({
  valueAt: (address) => values[address] ?? '',
  isError: (address) => (options.errors ?? []).includes(address),
  evaluateFormula: options.formula ?? (() => ''),
});

describe('addressesOfRange', () => {
  it('expands a rectangle row-major', () => {
    expect(addressesOfRange('A1:B2')).toEqual(['A1', 'B1', 'A2', 'B2']);
  });

  it('accepts a single cell', () => {
    expect(addressesOfRange('C3')).toEqual(['C3']);
  });

  it('normalises a range written backwards', () => {
    expect(addressesOfRange('B2:A1')).toEqual(['A1', 'B1', 'A2', 'B2']);
  });

  it.each(['', 'nonsense', 'A1:', ':B2', '1:2'])('yields nothing for %j', (range) => {
    expect(addressesOfRange(range)).toEqual([]);
  });

  it('finds the top-left anchor regardless of how the range was written', () => {
    expect(rangeAnchor('D4:B2')).toEqual({ row: 1, column: 1 });
    expect(rangeAnchor('bogus')).toBeNull();
  });
});

describe('matchesCondition', () => {
  it.each([
    [5, 'greaterThan', '3', true],
    [5, 'greaterThan', '5', false],
    [5, 'greaterThanOrEqual', '5', true],
    [5, 'lessThan', '10', true],
    [5, 'lessThanOrEqual', '4', false],
    [5, 'equal', '5', true],
    [5, 'notEqual', '5', false],
  ] as const)('%s %s %s -> %s', (value, operator, compare, expected) => {
    expect(matchesCondition(value, false, { operator, value: compare })).toBe(expected);
  });

  it('treats a numeric string in the cell as a number', () => {
    expect(matchesCondition('42', false, { operator: 'greaterThan', value: '10' })).toBe(true);
  });

  it('does not match a numeric comparison against non-numeric text', () => {
    // Coercing "done" to NaN and comparing would be false anyway, but by
    // accident rather than by decision.
    expect(matchesCondition('done', false, { operator: 'greaterThan', value: '10' })).toBe(false);
  });

  it('falls back to text for equality, so a status column works', () => {
    expect(matchesCondition('Done', false, { operator: 'equal', value: 'done' })).toBe(true);
    expect(matchesCondition('Blocked', false, { operator: 'notEqual', value: 'done' })).toBe(true);
  });

  it.each([
    ['contains', 'urgent', true],
    ['contains', 'later', false],
    ['startsWith', 'very', true],
    ['startsWith', 'urgent', false],
    ['endsWith', 'urgent', true],
    ['notContains', 'later', true],
  ] as const)('%s %j -> %s', (operator, compare, expected) => {
    expect(matchesCondition('very urgent', false, { operator, value: compare })).toBe(expected);
  });

  it('is case-insensitive on text comparisons', () => {
    expect(matchesCondition('VERY Urgent', false, { operator: 'contains', value: 'urgent' })).toBe(true);
  });

  it('never matches contains against an empty needle', () => {
    // Otherwise every cell in the range lights up the moment a rule is created
    // and before anything has been typed into it.
    expect(matchesCondition('anything', false, { operator: 'contains', value: '' })).toBe(false);
  });

  it('handles emptiness', () => {
    expect(matchesCondition('', false, { operator: 'isEmpty' })).toBe(true);
    expect(matchesCondition('x', false, { operator: 'isNotEmpty' })).toBe(true);
    expect(matchesCondition('', false, { operator: 'isNotEmpty' })).toBe(false);
  });

  it('bounds a between range in either order', () => {
    const between = { operator: 'between' as const, value: '10', value2: '1' };
    expect(matchesCondition(5, false, between)).toBe(true);
    expect(matchesCondition(50, false, between)).toBe(false);
    expect(matchesCondition(5, false, { ...between, operator: 'notBetween' })).toBe(false);
  });

  it('does not match between when the upper bound is missing', () => {
    expect(matchesCondition(5, false, { operator: 'between', value: '1' })).toBe(false);
  });

  describe('error cells', () => {
    it('matches only isError', () => {
      expect(matchesCondition('', true, { operator: 'isError' })).toBe(true);
    });

    it('matches no value-based operator, however the error renders', () => {
      // `#ERROR` is text, so "contains E" or "is not empty" would otherwise
      // light up every broken cell in the range.
      expect(matchesCondition('#ERROR', true, { operator: 'contains', value: 'e' })).toBe(false);
      expect(matchesCondition('#ERROR', true, { operator: 'isNotEmpty' })).toBe(false);
      expect(matchesCondition('#ERROR', true, { operator: 'greaterThan', value: '0' })).toBe(false);
    });
  });
});

describe('single-colour rules', () => {
  const rule = (over: number): ConditionalRule => ({
    id: 'r1',
    kind: 'cell',
    ranges: ['A1:A3'],
    condition: { operator: 'greaterThan', value: String(over) },
    format: { background: '#fee2e2' },
  });

  it('formats only the cells that match', () => {
    const result = evaluateConditionalFormats(
      [rule(50)],
      contextOf({ A1: 100, A2: 10, A3: 60 })
    );
    expect(Object.keys(result.formats).sort()).toEqual(['A1', 'A3']);
    expect(result.formats.A1).toEqual({ background: '#fee2e2' });
  });

  it('returns nothing at all for an empty rule list', () => {
    expect(evaluateConditionalFormats([], contextOf({ A1: 1 }))).toEqual({ formats: {}, bars: {} });
  });

  it('layers later rules over earlier ones field by field', () => {
    // A rule that only sets a text colour must not wipe an earlier fill.
    const result = evaluateConditionalFormats(
      [
        { id: 'a', kind: 'cell', ranges: ['A1'], condition: { operator: 'isNotEmpty' }, format: { background: '#fee2e2' } },
        { id: 'b', kind: 'cell', ranges: ['A1'], condition: { operator: 'isNotEmpty' }, format: { bold: true } },
      ],
      contextOf({ A1: 'x' })
    );
    expect(result.formats.A1).toEqual({ background: '#fee2e2', bold: true });
  });

  it('lets a later rule override the same field', () => {
    const result = evaluateConditionalFormats(
      [
        { id: 'a', kind: 'cell', ranges: ['A1'], condition: { operator: 'isNotEmpty' }, format: { background: '#fee2e2' } },
        { id: 'b', kind: 'cell', ranges: ['A1'], condition: { operator: 'isNotEmpty' }, format: { background: '#dcfce7' } },
      ],
      contextOf({ A1: 'x' })
    );
    expect(result.formats.A1.background).toBe('#dcfce7');
  });

  it('skips a rule whose range is unparseable rather than throwing', () => {
    expect(
      evaluateConditionalFormats(
        [{ id: 'r', kind: 'cell', ranges: ['not-a-range'], condition: { operator: 'isNotEmpty' }, format: { bold: true } }],
        contextOf({ A1: 'x' })
      ).formats
    ).toEqual({});
  });
});

describe('formula rules', () => {
  it('shifts relative references from the range anchor', () => {
    const seen: string[] = [];
    const result = evaluateConditionalFormats(
      [{ id: 'r', kind: 'formula', ranges: ['A1:A3'], formula: '=A1>10', format: { bold: true } }],
      contextOf({}, {
        formula: (formula) => {
          seen.push(formula);
          return formula === '=A2>10';
        },
      })
    );
    // One evaluation per cell, each anchored to its own row.
    expect(seen).toEqual(['=A1>10', '=A2>10', '=A3>10']);
    expect(Object.keys(result.formats)).toEqual(['A2']);
  });

  it('does not take the sheet down when a rule formula throws', () => {
    const result = evaluateConditionalFormats(
      [{ id: 'r', kind: 'formula', ranges: ['A1:A2'], formula: '=BROKEN(', format: { bold: true } }],
      contextOf({}, { formula: () => { throw new Error('parse error'); } })
    );
    expect(result.formats).toEqual({});
  });

  it.each([
    [true, true],
    [false, false],
    [1, true],
    [0, false],
    ['TRUE', true],
    ['', false],
    ['no', false],
  ] as const)('treats %j as %s', (value, expected) => {
    const result = evaluateConditionalFormats(
      [{ id: 'r', kind: 'formula', ranges: ['A1'], formula: '=X', format: { bold: true } }],
      contextOf({}, { formula: () => value })
    );
    expect(Object.keys(result.formats).length === 1).toBe(expected);
  });
});

describe('colour scales', () => {
  const scale: ConditionalRule = {
    id: 's',
    kind: 'colorScale',
    ranges: ['A1:A3'],
    min: { type: 'min', color: '#ffffff' },
    max: { type: 'max', color: '#000000' },
  };

  it('places each value on the gradient', () => {
    const result = evaluateConditionalFormats([scale], contextOf({ A1: 0, A2: 5, A3: 10 }));
    expect(result.formats.A1.background).toBe('#ffffff');
    expect(result.formats.A3.background).toBe('#000000');
    expect(result.formats.A2.background).toBe('#808080');
  });

  it('gives every cell the low colour when the range is flat', () => {
    // The alternative is dividing by a zero span.
    const result = evaluateConditionalFormats([scale], contextOf({ A1: 7, A2: 7, A3: 7 }));
    expect(result.formats.A2.background).toBe('#ffffff');
  });

  it('ignores non-numeric and error cells', () => {
    const result = evaluateConditionalFormats(
      [scale],
      contextOf({ A1: 0, A2: 'text', A3: 10 }, { errors: ['A3'] })
    );
    expect(result.formats.A2).toBeUndefined();
    expect(result.formats.A3).toBeUndefined();
    expect(result.formats.A1).toBeDefined();
  });

  it('produces nothing when the range holds no numbers', () => {
    expect(evaluateConditionalFormats([scale], contextOf({ A1: 'a', A2: 'b' })).formats).toEqual({});
  });

  it('interpolates through a midpoint on both sides', () => {
    const threeColour: ConditionalRule = {
      ...scale,
      mid: { type: 'percentile', value: 50, color: '#ff0000' },
    } as ConditionalRule;
    const result = evaluateConditionalFormats([threeColour], contextOf({ A1: 0, A2: 5, A3: 10 }));
    expect(result.formats.A2.background).toBe('#ff0000');
    // Quarter of the way up is halfway between the low colour and the midpoint.
    const quarter = evaluateConditionalFormats([threeColour], contextOf({ A1: 0, A2: 2.5, A3: 10 }));
    expect(quarter.formats.A2.background).toBe('#ff8080');
  });

  it('anchors to explicit numbers when asked', () => {
    const fixed: ConditionalRule = {
      ...scale,
      min: { type: 'number', value: 0, color: '#ffffff' },
      max: { type: 'number', value: 100, color: '#000000' },
    } as ConditionalRule;
    // 50 of a fixed 0..100 is the midpoint, regardless of the data's own range.
    const result = evaluateConditionalFormats([fixed], contextOf({ A1: 50, A2: 50, A3: 50 }));
    expect(result.formats.A1.background).toBe('#808080');
  });
});

describe('data bars', () => {
  const bar: ConditionalRule = {
    id: 'b',
    kind: 'dataBar',
    ranges: ['A1:A3'],
    color: '#3b82f6',
  };

  it('reports a fraction per cell, not a CellFormat', () => {
    const result = evaluateConditionalFormats([bar], contextOf({ A1: 0, A2: 5, A3: 10 }));
    expect(result.formats).toEqual({});
    expect(result.bars.A1).toEqual({ color: '#3b82f6', fraction: 0 });
    expect(result.bars.A2.fraction).toBeCloseTo(0.5);
    expect(result.bars.A3.fraction).toBe(1);
  });

  it('measures from zero rather than from the smallest value', () => {
    // Otherwise the smallest bar is always empty, which misreads a column of
    // similar large numbers as one tiny value and two full ones.
    const result = evaluateConditionalFormats([bar], contextOf({ A1: 90, A2: 95, A3: 100 }));
    expect(result.bars.A1.fraction).toBeCloseTo(0.9);
  });

  it('handles negative values by extending the baseline below zero', () => {
    const result = evaluateConditionalFormats([bar], contextOf({ A1: -10, A2: 0, A3: 10 }));
    expect(result.bars.A1.fraction).toBe(0);
    expect(result.bars.A2.fraction).toBeCloseTo(0.5);
  });

  it('skips non-numeric cells', () => {
    const result = evaluateConditionalFormats([bar], contextOf({ A1: 1, A2: 'text' }));
    expect(result.bars.A2).toBeUndefined();
  });
});

describe('mixColors', () => {
  it('interpolates channel by channel', () => {
    expect(mixColors('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixColors('#ff0000', '#0000ff', 1)).toBe('#0000ff');
  });

  it('clamps out-of-range amounts', () => {
    expect(mixColors('#000000', '#ffffff', -1)).toBe('#000000');
    expect(mixColors('#000000', '#ffffff', 2)).toBe('#ffffff');
  });

  it('returns null for a colour it cannot parse, rather than a broken hex', () => {
    expect(mixColors('red', '#ffffff', 0.5)).toBeNull();
    expect(mixColors('#fff', '#ffffff', 0.5)).toBeNull();
  });
});
