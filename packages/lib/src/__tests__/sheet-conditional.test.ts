import { describe, it, expect } from 'vitest';
import {
  MAX_CONDITIONAL_RANGE_CELLS,
  MAX_CONDITIONAL_RANGES_PER_RULE,
  MAX_CONDITIONAL_RULE_MAP_KEYS_SCANNED,
  MAX_CONDITIONAL_RULES,
  MAX_CONDITIONAL_TOTAL_CELLS,
  addressesOfRange,
  parseConditionalRule,
  parseConditionalRules,
  evaluateConditionalFormats,
  matchesCondition,
  mixColors,
  rangeAnchor,
  type ConditionalContext,
  type ConditionalRule,
} from '../sheets/conditional';
import { rowsFromSheetData, sheetDataFromRows } from '../sheets/projection';
import {
  createEmptySheet,
  evaluateSheet,
  evaluateSheetSparse,
  parseSheetContent,
  sanitizeSheetData,
  serializeSheetContent,
  type SheetData,
  type SheetPrimitive,
} from '../sheets/sheet';

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

  it.each(['A0', 'A0:A2', 'A1:B0'])('yields nothing for %j rather than throwing', (range) => {
    // `decodeCellAddress` accepts `A0` and hands back row -1, because rows are
    // 1-based going in. Expanding that threw, so one malformed stored rule took
    // the whole sheet's evaluation down with it.
    expect(() => addressesOfRange(range)).not.toThrow();
    expect(addressesOfRange(range)).toEqual([]);
    expect(rangeAnchor(range)).toBeNull();
  });

  it('refuses a range too large to expand, instead of hanging on it', () => {
    // `A1:ZZZ5000000` is a *valid* range naming ~90 billion cells. Rules are
    // stored as jsonb the API can write, so this has to be bounded rather than
    // trusted. Timed, because the failure mode is a hang, not a wrong answer.
    const started = Date.now();
    expect(addressesOfRange('A1:ZZZ5000000')).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('still expands a range at the ceiling', () => {
    // 500,000 cells exactly: 500 columns x 1,000 rows.
    expect(addressesOfRange('A1:SF1000')).toHaveLength(MAX_CONDITIONAL_RANGE_CELLS);
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

  it('shifts lowercase references too', () => {
    // The tokenizer accepts and normalises `a1`, so a rule can legitimately
    // hold lowercase references. They used to be left unshifted, so `=a1>b1`
    // evaluated the identical expression for every cell in the range.
    const seen: string[] = [];
    evaluateConditionalFormats(
      [{ id: 'r', kind: 'formula', ranges: ['A1:A3'], formula: '=a1>b1', format: { bold: true } }],
      contextOf({}, { formula: (formula) => { seen.push(formula); return false; } })
    );
    expect(seen).toEqual(['=A1>B1', '=A2>B2', '=A3>B3']);
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
    // A percentile-50 midpoint tracks the data's own median, so the middle of
    // three values always lands exactly on it. Partial blending is asserted
    // against a fixed midpoint below, where the anchor does not move.
    const result = evaluateConditionalFormats([threeColour], contextOf({ A1: 0, A2: 5, A3: 10 }));
    expect(result.formats.A2.background).toBe('#ff0000');

    const skewed = evaluateConditionalFormats([threeColour], contextOf({ A1: 0, A2: 2, A3: 10 }));
    // Median is 2, so A3 sits between the midpoint and the max.
    expect(skewed.formats.A2.background).toBe('#ff0000');
    expect(skewed.formats.A1.background).toBe('#ffffff');
  });

  it('places the midpoint colour where its anchor says, not at the halfway mark', () => {
    // A midpoint configured at 10 on a fixed 0..100 scale must render its
    // colour AT 10. Interpolating around a hardcoded 0.5 put it at 50 and left
    // the `number`, `percent` and non-median `percentile` settings inert.
    const anchored: ConditionalRule = {
      id: 's', kind: 'colorScale', ranges: ['A1:A3'],
      min: { type: 'number', value: 0, color: '#000000' },
      mid: { type: 'number', value: 10, color: '#ff0000' },
      max: { type: 'number', value: 100, color: '#ffffff' },
    };
    const result = evaluateConditionalFormats([anchored], contextOf({ A1: 0, A2: 10, A3: 100 }));
    expect(result.formats.A2.background).toBe('#ff0000');

    // ...and the value halfway to it takes half the blend from the low colour.
    const half = evaluateConditionalFormats([anchored], contextOf({ A1: 0, A2: 5, A3: 100 }));
    expect(half.formats.A2.background).toBe('#800000');
  });

  it('still blends across the remaining side when the midpoint sits on an end anchor', () => {
    // A midpoint pinned to the low end leaves no room below it, but the whole
    // range above it must still blend mid -> max. Collapsing the entire scale
    // to the midpoint colour would be a flat block of one colour.
    const atLow: ConditionalRule = {
      id: 's', kind: 'colorScale', ranges: ['A1:A3'],
      min: { type: 'number', value: 0, color: '#000000' },
      mid: { type: 'number', value: 0, color: '#ff0000' },
      max: { type: 'number', value: 10, color: '#ffffff' },
    };
    const low = evaluateConditionalFormats([atLow], contextOf({ A1: 0, A2: 5, A3: 10 }));
    expect(low.formats.A1.background).toBe('#ff0000');
    expect(low.formats.A2.background).toBe('#ff8080');
    expect(low.formats.A3.background).toBe('#ffffff');

    // ...and the mirror image, pinned to the high end.
    const atHigh: ConditionalRule = {
      ...atLow,
      mid: { type: 'number', value: 10, color: '#ff0000' },
    } as ConditionalRule;
    const high = evaluateConditionalFormats([atHigh], contextOf({ A1: 0, A2: 5, A3: 10 }));
    expect(high.formats.A1.background).toBe('#000000');
    expect(high.formats.A2.background).toBe('#800000');
    expect(high.formats.A3.background).toBe('#ff0000');
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

  it('honors an explicit positive `number` min anchor rather than forcing the baseline to zero', () => {
    // All-positive data with a configured min of 50: the baseline should sit
    // at 50, not silently clamp to 0 and compress every bar toward the low end.
    const explicitMin: ConditionalRule = {
      id: 'b2',
      kind: 'dataBar',
      ranges: ['A1:A3'],
      color: '#3b82f6',
      min: { type: 'number', value: 50 },
      max: { type: 'number', value: 100 },
    };
    const result = evaluateConditionalFormats(
      [explicitMin],
      contextOf({ A1: 50, A2: 75, A3: 100 })
    );
    expect(result.bars.A1.fraction).toBe(0);
    expect(result.bars.A2.fraction).toBeCloseTo(0.5);
    expect(result.bars.A3.fraction).toBe(1);
  });

  it('still clamps the default auto min anchor to zero for all-positive data', () => {
    const result = evaluateConditionalFormats([bar], contextOf({ A1: 50, A2: 75, A3: 100 }));
    // Auto anchor (no explicit `min`) measures from 0, not from the smallest
    // value (50) — otherwise A1 would render as an empty bar.
    expect(result.bars.A1.fraction).toBeCloseTo(0.5);
  });
});

describe('aggregate cell budget across all rules combined', () => {
  it('bounds total conditional evaluation work at MAX_CONDITIONAL_TOTAL_CELLS, even split across rules and ranges each individually under MAX_CONDITIONAL_RANGE_CELLS', () => {
    // Four ranges of exactly MAX_CONDITIONAL_RANGE_CELLS each, in one rule,
    // exhaust the whole aggregate budget on their own.
    const bigRule: ConditionalRule = {
      id: 'big',
      kind: 'cell',
      ranges: ['A1:A500000', 'B1:B500000', 'C1:C500000', 'D1:D500000'],
      condition: { operator: 'isNotEmpty' },
      format: { bold: true },
    };
    const extraRule: ConditionalRule = {
      id: 'extra',
      kind: 'cell',
      ranges: ['E1'],
      condition: { operator: 'isNotEmpty' },
      format: { italic: true },
    };
    expect(
      bigRule.ranges.reduce((sum, r) => sum + addressesOfRange(r).length, 0)
    ).toBe(MAX_CONDITIONAL_TOTAL_CELLS);

    const context: ConditionalContext = {
      valueAt: () => 'x',
      isError: () => false,
      evaluateFormula: () => '',
    };
    const result = evaluateConditionalFormats([bigRule, extraRule], context);

    expect(result.formats.A1).toEqual({ bold: true });
    expect(result.formats.D500000).toEqual({ bold: true });
    // The aggregate budget was fully spent by `bigRule`, so `extraRule` —
    // despite covering just one cell, well under any per-range cap —
    // contributes nothing.
    expect(result.formats.E1).toBeUndefined();
  }, 20000);

  it('bounds a single rule holding many individually-valid ranges, without expanding them all before applying the budget', () => {
    // `rule.ranges` is API-writable jsonb with no cap on entry count: one
    // rule can hold far more ranges than four. Ten ranges of
    // MAX_CONDITIONAL_RANGE_CELLS each (5,000,000 combined) sum to well past
    // the 2,000,000 aggregate budget — flat-mapping every range before
    // slicing to the budget would transiently allocate all 5,000,000
    // addresses (and previously crashed outright: spreading that many
    // elements onto `Array.prototype.push` blows the engine's call-stack
    // argument limit). `expandRangesWithinBudget` must stop consuming
    // ranges as soon as the budget is spent instead.
    const manyRangesRule: ConditionalRule = {
      id: 'many',
      kind: 'cell',
      ranges: Array.from({ length: 10 }, (_, i) => {
        const col = String.fromCharCode(65 + i); // A..J
        return `${col}1:${col}500000`;
      }),
      condition: { operator: 'isNotEmpty' },
      format: { bold: true },
    };

    const context: ConditionalContext = {
      valueAt: () => 'x',
      isError: () => false,
      evaluateFormula: () => '',
    };

    expect(() => evaluateConditionalFormats([manyRangesRule], context)).not.toThrow();
    const result = evaluateConditionalFormats([manyRangesRule], context);

    // First four ranges (A..D) exhaust the budget exactly, as in the test
    // above; nothing from range five (E) onward is painted.
    expect(result.formats.A1).toEqual({ bold: true });
    expect(result.formats.D500000).toEqual({ bold: true });
    expect(result.formats.E1).toBeUndefined();
    expect(result.formats.J1).toBeUndefined();
  }, 20000);
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

// --- storage -------------------------------------------------------------

describe('parseConditionalRule', () => {
  const cellRule = {
    id: 'r1',
    kind: 'cell',
    ranges: ['A1:A9'],
    condition: { operator: 'greaterThan', value: '10' },
    format: { background: '#fee2e2' },
  };

  it('accepts a well-formed rule', () => {
    expect(parseConditionalRule(cellRule)).toMatchObject({ id: 'r1', kind: 'cell' });
  });

  it.each([
    ['no id', { ...cellRule, id: '' }],
    ['no ranges', { ...cellRule, ranges: [] }],
    ['ranges not an array', { ...cellRule, ranges: 'A1:A9' }],
    ['unknown kind', { ...cellRule, kind: 'telepathy' }],
    ['unknown operator', { ...cellRule, condition: { operator: 'vibes' } }],
    ['missing condition', { ...cellRule, condition: undefined }],
    ['not an object', 'nope'],
    ['null', null],
  ])('drops a rule with %s', (_label, value) => {
    expect(parseConditionalRule(value)).toBeNull();
  });

  it('drops a colour scale missing an end colour, which has no gradient', () => {
    expect(
      parseConditionalRule({
        id: 's', kind: 'colorScale', ranges: ['A1:A9'],
        min: { type: 'min' }, max: { type: 'max', color: '#000000' },
      })
    ).toBeNull();
  });

  it('drops a data bar whose colour is not a hex value', () => {
    expect(
      parseConditionalRule({ id: 'b', kind: 'dataBar', ranges: ['A1'], color: 'red' })
    ).toBeNull();
  });

  it('strips a format field the schema rejects but keeps the rest of the rule', () => {
    const parsed = parseConditionalRule({
      ...cellRule,
      format: { background: '#fee2e2', color: 'javascript:alert(1)' },
    });
    expect(parsed?.kind).toBe('cell');
    expect((parsed as unknown as { format: Record<string, unknown> }).format).toEqual({ background: '#fee2e2' });
  });

  it('carries an unknown field on an otherwise valid rule, for forward compatibility', () => {
    const parsed = parseConditionalRule({ ...cellRule, stopIfTrue: true });
    expect((parsed as unknown as Record<string, unknown>).stopIfTrue).toBe(true);
  });

  it('lower-cases stored colours so comparisons are stable', () => {
    const parsed = parseConditionalRule({ id: 'b', kind: 'dataBar', ranges: ['A1'], color: '#3B82F6' });
    expect((parsed as { color: string }).color).toBe('#3b82f6');
  });
});

describe('parseConditionalRules', () => {
  const rule = (id: string) => ({
    id, kind: 'cell', ranges: ['A1'],
    condition: { operator: 'isNotEmpty' }, format: { bold: true },
  });

  it('reads an array', () => {
    expect(parseConditionalRules([rule('a'), rule('b')])?.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('restores order from the numerically-keyed map the TOML bag stores', () => {
    const stored = { '10': rule('k'), '2': rule('b'), '1': rule('a') };
    expect(parseConditionalRules(stored)?.map((r) => r.id)).toEqual(['a', 'b', 'k']);
  });

  it('orders by numeric value, not by key-insertion order', () => {
    // JS already enumerates canonical integer keys ascending, so the case above
    // would pass without any sorting at all. A non-canonical key like "01" is
    // enumerated in insertion order instead, which is what actually exercises
    // it — and is what a hand-written or newer-writer document can contain.
    // Order is load-bearing here: later rules layer over earlier ones.
    const stored = { '2': rule('second'), '01': rule('first') };
    expect(Object.keys(stored)).toEqual(['2', '01']);
    expect(parseConditionalRules(stored)?.map((r) => r.id)).toEqual(['first', 'second']);
  });

  it('drops the invalid entries and keeps the rest', () => {
    expect(parseConditionalRules([rule('a'), { junk: true }, rule('b')])?.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('is undefined rather than empty when nothing survives', () => {
    expect(parseConditionalRules([{ junk: true }])).toBeUndefined();
    expect(parseConditionalRules(undefined)).toBeUndefined();
    expect(parseConditionalRules('nope')).toBeUndefined();
  });

  it('caps the rule count at MAX_CONDITIONAL_RULES, an API write cannot exceed the parse boundary', () => {
    const many = Array.from({ length: MAX_CONDITIONAL_RULES + 50 }, (_, i) => rule(`r${i}`));
    const parsed = parseConditionalRules(many);
    expect(parsed).toHaveLength(MAX_CONDITIONAL_RULES);
    expect(parsed?.[0].id).toBe('r0');
    expect(parsed?.[parsed.length - 1].id).toBe(`r${MAX_CONDITIONAL_RULES - 1}`);
  });

  it('stops parsing once MAX_CONDITIONAL_RULES valid rules are collected, rather than parsing every entry first', () => {
    // A `.map(parse).filter(valid).slice(cap)` pipeline parses every entry
    // before the cap ever applies — unbounded CPU on an unbounded array. A
    // Proxy counts index reads during `parseConditionalRules`' own iteration
    // (untouched by this array's `.length` or the `Array.from` that built
    // it) to prove the fix actually stops early rather than merely trimming
    // the output.
    const raw = Array.from({ length: MAX_CONDITIONAL_RULES * 10 }, (_, i) => rule(`r${i}`));
    let indexReads = 0;
    const tracked = new Proxy(raw, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) indexReads += 1;
        return Reflect.get(target, prop, receiver);
      },
    });

    const parsed = parseConditionalRules(tracked);

    expect(parsed).toHaveLength(MAX_CONDITIONAL_RULES);
    expect(indexReads).toBeLessThan(MAX_CONDITIONAL_RULES * 2);
  });

  it('bounds the numerically-keyed map path too, before the sort that reconstructs order', () => {
    // The array path is bounded by collecting incrementally, but the
    // TOML-bag map path (`{"0": rule, "1": rule, ...}`) has to sort every
    // candidate key before it can even start parsing, so "stop once enough
    // valid ones are found" isn't available for this branch specifically.
    // Key enumeration itself is bounded with a `for...in` loop that breaks
    // once `MAX_CONDITIONAL_RULE_MAP_KEYS_SCANNED` keys are collected —
    // unlike `Object.keys`, which always materializes every own key into an
    // array before anything else can run. A `Proxy` can't observe that part
    // (its `ownKeys` trap must hand back the complete key list atomically
    // either way), but it can observe the step after: property-value reads
    // on the stored object, which is what would otherwise touch every one
    // of a huge object's rule payloads rather than just the ones that make
    // the cut.
    const raw: Record<string, unknown> = {};
    for (let i = 0; i < MAX_CONDITIONAL_RULE_MAP_KEYS_SCANNED * 3; i++) {
      raw[String(i)] = rule(`r${i}`);
    }
    let valueReads = 0;
    const tracked = new Proxy(raw, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) valueReads += 1;
        return Reflect.get(target, prop, receiver);
      },
    });

    const parsed = parseConditionalRules(tracked);

    expect(parsed).toHaveLength(MAX_CONDITIONAL_RULES);
    expect(parsed?.[0].id).toBe('r0');
    expect(parsed?.[parsed.length - 1].id).toBe(`r${MAX_CONDITIONAL_RULES - 1}`);
    // Bounded by MAX_CONDITIONAL_RULE_MAP_KEYS_SCANNED, not by the object's
    // real size (3x larger here).
    expect(valueReads).toBeLessThan(MAX_CONDITIONAL_RULE_MAP_KEYS_SCANNED * 2);
  });

  it('collects keys via bounded iteration rather than materializing the full key list first', () => {
    // A plain object, not a Proxy: exercises the real `for...in` early break
    // this fix relies on, rather than downstream effects of it. Correctness
    // check — the ordering/cap guarantees hold the same way for a genuinely
    // large object as they do for the smaller ones above.
    const raw: Record<string, unknown> = {};
    const total = MAX_CONDITIONAL_RULE_MAP_KEYS_SCANNED * 5;
    for (let i = 0; i < total; i++) {
      raw[String(i)] = rule(`r${i}`);
    }

    const parsed = parseConditionalRules(raw);

    expect(parsed).toHaveLength(MAX_CONDITIONAL_RULES);
    expect(parsed?.[0].id).toBe('r0');
    expect(parsed?.[parsed.length - 1].id).toBe(`r${MAX_CONDITIONAL_RULES - 1}`);
  });

  it('ignores an inherited enumerable property, matching Object.keys semantics', () => {
    // `for...in` walks the prototype chain; `Object.keys` does not. The
    // `hasOwnProperty` filter is what keeps the two equivalent here.
    const proto = { '99': rule('inherited') };
    const own = Object.create(proto);
    own['0'] = rule('own');

    const parsed = parseConditionalRules(own);

    expect(parsed?.map((r) => r.id)).toEqual(['own']);
  });
});

describe('conditional rule ranges: per-rule entry cap', () => {
  it('caps the number of range entries one rule holds at MAX_CONDITIONAL_RANGES_PER_RULE', () => {
    // `addressesOfRange` returns [] for an invalid or oversized range, so a
    // `ranges` array padded with an unbounded number of such entries would
    // otherwise cost unbounded CPU (one parse/decode per entry) without the
    // per-cell budget ever tripping, since nothing is ever consumed from it.
    const many = Array.from({ length: MAX_CONDITIONAL_RANGES_PER_RULE + 500 }, (_, i) => `A${i + 1}`);
    const parsed = parseConditionalRule({
      id: 'r',
      kind: 'cell',
      ranges: many,
      condition: { operator: 'isNotEmpty' },
      format: { bold: true },
    });
    expect(parsed?.ranges).toHaveLength(MAX_CONDITIONAL_RANGES_PER_RULE);
    expect(parsed?.ranges[0]).toBe('A1');
    expect(parsed?.ranges[MAX_CONDITIONAL_RANGES_PER_RULE - 1]).toBe(`A${MAX_CONDITIONAL_RANGES_PER_RULE}`);
  });
});

describe('addressesOfRange: maxCount', () => {
  it('stops enumerating at maxCount rather than building the full range and trimming it after', () => {
    // A range within MAX_CONDITIONAL_RANGE_CELLS on its own, asked for far
    // fewer addresses than it actually has.
    expect(addressesOfRange('A1:A100', 3)).toEqual(['A1', 'A2', 'A3']);
  });

  it('still rejects a range over MAX_CONDITIONAL_RANGE_CELLS wholesale, regardless of maxCount', () => {
    // maxCount only ever narrows; it must never let an otherwise-oversized
    // range through just because the caller asked for a small maxCount.
    expect(addressesOfRange('A1:ZZ500001', 1)).toEqual([]);
  });

  it('defaults to MAX_CONDITIONAL_RANGE_CELLS, unchanged from before this parameter existed', () => {
    expect(addressesOfRange('A1:SF1000')).toHaveLength(MAX_CONDITIONAL_RANGE_CELLS);
  });
});

describe('round trip through the document', () => {
  const withRules = (): SheetData => {
    const sheet = createEmptySheet();
    sheet.cells.A1 = '5';
    sheet.conditionalFormats = [
      {
        id: 'r1', kind: 'cell', ranges: ['A1:A9'],
        condition: { operator: 'greaterThan', value: '3' },
        format: { background: '#fee2e2', bold: true },
      },
      {
        id: 's1', kind: 'colorScale', ranges: ['B1:B9'],
        min: { type: 'min', color: '#ffffff' },
        mid: { type: 'percentile', value: 50, color: '#fef3c7' },
        max: { type: 'max', color: '#22c55e' },
      },
      { id: 'b1', kind: 'dataBar', ranges: ['C1:C9'], color: '#3b82f6' },
    ];
    return sheet;
  };

  it('survives serialize and parse intact', () => {
    const restored = parseSheetContent(serializeSheetContent(withRules()));
    expect(restored.conditionalFormats).toEqual(withRules().conditionalFormats);
  });

  it('keeps rule order across the round trip', () => {
    const restored = parseSheetContent(serializeSheetContent(withRules()));
    expect(restored.conditionalFormats?.map((r) => r.id)).toEqual(['r1', 's1', 'b1']);
  });

  it('does not leak the internal key into user-visible named ranges', () => {
    // `__columnFormats` and `__rowHeights` already ride in this bag under the
    // same convention; a third must not start showing up as a named range.
    const restored = parseSheetContent(serializeSheetContent(withRules()));
    expect(restored.ranges).toBeUndefined();
  });

  it('leaves a genuine named range alongside the rules alone', () => {
    const sheet = withRules();
    sheet.ranges = { myRange: { ref: 'A1:B2' } };
    const restored = parseSheetContent(serializeSheetContent(sheet));
    expect(restored.ranges).toEqual({ myRange: { ref: 'A1:B2' } });
    expect(restored.conditionalFormats).toHaveLength(3);
  });

  it('omits the field entirely when a sheet has no rules', () => {
    const restored = parseSheetContent(serializeSheetContent(createEmptySheet()));
    expect(restored.conditionalFormats).toBeUndefined();
  });

  it('survives repeated save cycles without drift', () => {
    let content = serializeSheetContent(withRules());
    for (let cycle = 0; cycle < 3; cycle++) {
      content = serializeSheetContent(parseSheetContent(content));
    }
    expect(parseSheetContent(content).conditionalFormats).toEqual(withRules().conditionalFormats);
  });
});

// --- wired into the evaluator --------------------------------------------

describe('conditional formatting through the evaluator', () => {
  const budget = (): SheetData => {
    const sheet = createEmptySheet();
    Object.assign(sheet.cells, { A1: '10', A2: '80', A3: '150' });
    sheet.conditionalFormats = [
      {
        id: 'over-100', kind: 'cell', ranges: ['A1:A3'],
        condition: { operator: 'greaterThan', value: '100' },
        format: { background: '#fee2e2' },
      },
    ];
    return sheet;
  };

  it('reaches every renderer through the evaluated format', () => {
    // Applied in the evaluator, not the grid, so the published page and both
    // exports see the same thing the editor does.
    const dense = evaluateSheet(budget());
    expect(dense.byAddress.A3.format?.background).toBe('#fee2e2');
    expect(dense.byAddress.A1.format?.background).toBeUndefined();
  });

  it('agrees between the dense and sparse evaluators', () => {
    const sparse = evaluateSheetSparse(budget());
    const dense = evaluateSheet(budget());
    for (const address of ['A1', 'A2', 'A3']) {
      expect(sparse.byAddress[address]?.format).toEqual(dense.byAddress[address]?.format);
    }
  });

  it('lets an explicit cell format win over a rule', () => {
    // The colour someone deliberately set is not silently overruled. Note this
    // is the opposite of Excel and Google Sheets.
    const sheet = budget();
    sheet.formats = { A3: { background: '#dcfce7' } };
    expect(evaluateSheet(sheet).byAddress.A3.format?.background).toBe('#dcfce7');
  });

  it('places a rule above a column default', () => {
    const sheet = budget();
    sheet.columnFormats = { A: { background: '#f1f5f9', italic: true } };
    const cell = evaluateSheet(sheet).byAddress.A3;
    expect(cell.format?.background).toBe('#fee2e2');
    // ...without discarding the fields the column default set.
    expect(cell.format?.italic).toBe(true);
  });

  it('paints a rule over cells that hold nothing', () => {
    // The sparse evaluator is seeded from the cells that exist, so a band
    // across empty cells would otherwise be stored and invisible.
    const sheet = createEmptySheet();
    sheet.conditionalFormats = [
      {
        id: 'blanks', kind: 'cell', ranges: ['C3:C5'],
        condition: { operator: 'isEmpty' },
        format: { background: '#fef3c7' },
      },
    ];
    expect(evaluateSheetSparse(sheet).byAddress.C4?.format?.background).toBe('#fef3c7');
    expect(evaluateSheet(sheet).byAddress.C4?.format?.background).toBe('#fef3c7');
  });

  it('reports data bars separately from formats', () => {
    const sheet = createEmptySheet();
    Object.assign(sheet.cells, { A1: '0', A2: '10' });
    sheet.conditionalFormats = [{ id: 'b', kind: 'dataBar', ranges: ['A1:A2'], color: '#3b82f6' }];

    const dense = evaluateSheet(sheet);
    expect(dense.bars?.A2).toEqual({ color: '#3b82f6', fraction: 1 });
    expect(dense.byAddress.A2.format?.background).toBeUndefined();
  });

  it('evaluates a formula rule against the sheet', () => {
    const sheet = createEmptySheet();
    Object.assign(sheet.cells, { A1: '5', B1: '10', A2: '20', B2: '3' });
    sheet.conditionalFormats = [
      {
        id: 'f', kind: 'formula', ranges: ['A1:A2'],
        formula: '=A1>B1',
        format: { bold: true },
      },
    ];
    const dense = evaluateSheet(sheet);
    // A1 (5) is not > B1 (10); A2 (20) is > B2 (3) once the rule shifts.
    expect(dense.byAddress.A1.format?.bold).toBeUndefined();
    expect(dense.byAddress.A2.format?.bold).toBe(true);
  });

  it('rebuilds the display grid so a rule cannot leave it stale', () => {
    const sheet = createEmptySheet();
    sheet.cells.A1 = '1234.5';
    sheet.conditionalFormats = [
      {
        id: 'money', kind: 'cell', ranges: ['A1'],
        condition: { operator: 'greaterThan', value: '0' },
        format: { number: { kind: 'currency', currency: 'USD', decimals: 2 } },
      },
    ];
    expect(evaluateSheet(sheet).display[0][0]).toBe('$1,234.50');
  });

  it('leaves a sheet with no rules exactly as it was', () => {
    const plain = createEmptySheet();
    plain.cells.A1 = '5';
    const evaluation = evaluateSheet(plain);
    expect(evaluation.bars).toBeUndefined();
    expect(evaluation.byAddress.A1.format).toBeUndefined();
  });
});

// --- through the row store -----------------------------------------------

describe('round trip through stored rows', () => {
  const ruled = (): SheetData => {
    const sheet = createEmptySheet();
    sheet.cells.A1 = '5';
    sheet.conditionalFormats = [
      {
        id: 'r1', kind: 'cell', ranges: ['A1:A9'],
        condition: { operator: 'greaterThan', value: '3' },
        format: { background: '#fee2e2' },
      },
    ];
    return sheet;
  };

  it('survives the row projection', () => {
    // Sheets live in rows now. Carrying rules only through the document would
    // mean a save through the store silently dropped every one of them.
    const { tab, rows } = rowsFromSheetData(ruled(), 0);
    expect(sheetDataFromRows(tab, rows).conditionalFormats).toEqual(ruled().conditionalFormats);
  });

  it('stores null rather than an empty list when a sheet has no rules', () => {
    expect(rowsFromSheetData(createEmptySheet(), 0).tab.conditionalFormats).toBeNull();
  });

  it('validates on the way out, so a malformed stored rule is not rendered', () => {
    // The column is deliberately untyped; this boundary decides what a rule is.
    const { tab, rows } = rowsFromSheetData(createEmptySheet(), 0);
    const restored = sheetDataFromRows(
      { ...tab, conditionalFormats: [{ id: 'x', kind: 'telepathy', ranges: ['A1'] }] },
      rows
    );
    expect(restored.conditionalFormats).toBeUndefined();
  });

  it('keeps the rules a document and the row store agree on identical', () => {
    const viaDocument = parseSheetContent(serializeSheetContent(ruled())).conditionalFormats;
    const { tab, rows } = rowsFromSheetData(ruled(), 0);
    expect(sheetDataFromRows(tab, rows).conditionalFormats).toEqual(viaDocument);
  });
});

describe('the write path', () => {
  it('carries a rule kind it does not recognise, rather than deleting it', () => {
    // sanitizeSheetData validates formats but deliberately does not validate
    // rules: `kind` is a closed set, so an older client would silently delete a
    // rule a newer build wrote. Unusable rules are filtered where they are read
    // instead, so nothing renders them.
    const sheet = createEmptySheet();
    sheet.conditionalFormats = [
      { id: 'future', kind: 'iconSet', ranges: ['A1:A9'] } as unknown as never,
    ];
    expect(sanitizeSheetData(sheet).conditionalFormats).toHaveLength(1);
  });

  it('still filters that rule out on read, so it is never rendered', () => {
    const sheet = createEmptySheet();
    sheet.conditionalFormats = [
      { id: 'future', kind: 'iconSet', ranges: ['A1:A9'] } as unknown as never,
    ];
    expect(parseSheetContent(serializeSheetContent(sheet)).conditionalFormats).toBeUndefined();
  });
});
